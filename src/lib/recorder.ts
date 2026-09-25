// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
/**
 * Запись микрофона (push-to-talk).
 *
 * Схема: startPushToTalk() запускает детачированный рекордер и возвращает сессию,
 * waitPushToTalkAuto() ждёт конца речи (по тишине) и мягко останавливает рекордер
 * (SIGINT, чтобы arecord успел финализировать WAV-заголовок). (Хуки opencode
 * выполняются строго последовательно, поэтому остановка по второй команде
 * невозможна.)
 *
 * В WSLg/RDP источник отдаёт сэмплы медленнее реального времени, поэтому
 * waitPushToTalkAuto ориентируется на длительность записанного аудио, а не на
 * настенное время.
 *
 * Бэкенд: arecord (в WSL самый надёжный — PulseAudio), иначе ffmpeg.
 */

import { spawn } from "node:child_process"
import { closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs"
import { silenceRms } from "./whisper.ts"

export interface PttOptions {
  sampleRate?: number
  channels?: number
  maxSeconds?: number
}

export interface PttSession {
  file: string
  pid: number
  backend: string
}

const SAMPLE_RATE = 16000
const CHANNELS = 1

/**
 * Явный источник PulseAudio (микрофон).
 *
 * Если записывать с default-source, то после обрыва канала audin PulseAudio
 * переключает default на RDPSink.monitor (лупбек) — и в файл попадает системный
 * звук вместо голоса. Поэтому источник задаём жёстко.
 */
function micSource(): string {
  return process.env.OPENCODE_VOICE_SOURCE || "RDPSource"
}

const DEFAULT_TMP_DIR = "/dev/shm/opencode-voice"

/**
 * Жёсткий предел длительности записи, с (env OPENCODE_VOICE_MAX_RECORD_SECONDS).
 * Обычно запись завершается раньше — авто-стопом по тишине.
 */
export function maxRecordSeconds(): number {
  const n = Number(process.env.OPENCODE_VOICE_MAX_RECORD_SECONDS ?? "300")
  return Number.isFinite(n) && n > 0 ? n : 300
}

/** Каталог для записей: по умолчанию RAM (tmpfs), а не диск. */
function recordingDir(): string {
  const dir = process.env.OPENCODE_VOICE_TMP_DIR || DEFAULT_TMP_DIR
  try { mkdirSync(dir, { recursive: true }) } catch {}
  return dir
}

/** Сколько секунд хранить запись перед удалением (для отладки/тестов). */
function retainSeconds(): number {
  const n = Number(process.env.OPENCODE_VOICE_RETAIN_SECONDS ?? "300")
  return Number.isFinite(n) ? n : 300
}

/**
 * Планирует удаление файла через retainSeconds.
 *
 * Делается отдельным detached-процессом (sleep + rm), поэтому удаление
 * переживёт перезапуск плагина. Если задан OPENCODE_VOICE_KEEP_AUDIO
 * (отладочное сохранение) — файл не удаляем.
 */
function scheduleDelete(file: string): void {
  if (process.env.OPENCODE_VOICE_KEEP_AUDIO) return
  const sec = retainSeconds()
  if (sec <= 0) return
  try {
    const child = spawn("sh", ["-c", `sleep ${Math.round(sec)}; rm -f "${file}"`], {
      detached: true,
      stdio: "ignore",
    })
    child.unref()
  } catch {}
}

async function which($: any, cmd: string): Promise<string | null> {
  try {
    const out = await $`command -v ${cmd}`.text()
    const p = out.trim()
    if (p) return p
  } catch {}
  // Fallback: песочница opencode не видит command -v, но бинарники в /usr/bin есть
  try { await $`test -x /usr/bin/${cmd}`.quiet(); return `/usr/bin/${cmd}` } catch {}
  try { await $`test -x /bin/${cmd}`.quiet(); return `/bin/${cmd}` } catch {}
  return null
}

export async function startPushToTalk($: any, opts: PttOptions = {}): Promise<PttSession> {
  const sr = opts.sampleRate || SAMPLE_RATE
  const ch = opts.channels || CHANNELS
  // Жёсткий предел записи; обычно срабатывает авто-стоп по тишине раньше.
  const max = opts.maxSeconds || maxRecordSeconds()
  const file = `${recordingDir()}/voice-ptt-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`
  scheduleDelete(file)

  // Убираем зависшие записи прошлых запусков — они держат микрофон.
  try { await $`pkill -f voice-ptt-`.quiet() } catch {}

  // Подмена рекордера (тесты/E2E): OPENCODE_VOICE_RECORDER_BIN=<любой исполняемый файл>
  // получает те же аргументы, что arecord, и пишет WAV в последний аргумент.
  const override = process.env.OPENCODE_VOICE_RECORDER_BIN
  const arec = override || (await which($, "arecord"))
  let bin: string
  let args: string[]
  let backend: string
  if (arec) {
    bin = arec
    backend = override ? "custom" : "arecord"
    args = ["-D", "pulse", "-f", "S16_LE", "-r", String(sr), "-c", String(ch), "-t", "wav", "-d", String(max), file]
  } else {
    const ffmpeg = await which($, "ffmpeg")
    if (!ffmpeg) throw new Error("не найден рекордер: установи alsa-utils (arecord) или ffmpeg")
    bin = ffmpeg
    backend = "ffmpeg"
    args = ["-nostdin", "-y", "-f", "alsa", "-ar", String(sr), "-ac", String(ch), "-i", "pulse", "-t", String(max), file]
  }

  const child = spawn(bin, args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PULSE_SOURCE: micSource() },
  })
  child.unref()
  if (!child.pid) throw new Error("не удалось запустить рекордер")
  return { file, pid: child.pid, backend }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Порог тишины (RMS) для авто-стопа: единый источник — shared/stt-spec.json (+ env).
const SILENCE_RMS = silenceRms()

/** Длительность и RMS последних ~0.4 c WAV (PCM16). */
function wavTail(file: string): { durMs: number; rms: number } | null {
  try {
    const size = statSync(file).size
    if (size < 44) return null
    const fd = openSync(file, "r")
    try {
      const head = Buffer.alloc(64)
      readSync(fd, head, 0, 64, 0)
      if (head.toString("ascii", 0, 4) !== "RIFF") return null
      let pos = 12
      let dataOff = -1
      let dataLen = 0
      let bytesPerSec = SAMPLE_RATE * CHANNELS * 2
      while (pos + 8 <= 64) {
        const id = head.toString("ascii", pos, pos + 4)
        const sz = head.readUInt32LE(pos + 4)
        if (id === "fmt ") {
          const ch = head.readUInt16LE(pos + 10)
          const sr = head.readUInt32LE(pos + 12)
          const bits = head.readUInt16LE(pos + 22)
          if (ch > 0 && sr > 0 && bits > 0) bytesPerSec = ch * sr * (bits / 8)
        }
        if (id === "data") {
          dataOff = pos + 8
          // Заголовок может врать (обрыв записи) — берём реальный размер файла.
          dataLen = Math.min(sz, size - dataOff)
          break
        }
        pos += 8 + sz + (sz % 2)
      }
      if (dataOff < 0 || dataLen <= 0) return null
      const durMs = (dataLen / bytesPerSec) * 1000
      const win = Math.min(dataLen, Math.max(2, Math.round((bytesPerSec * 0.4) / 2) * 2))
      const buf = Buffer.alloc(win)
      readSync(fd, buf, 0, win, dataOff + dataLen - win)
      let sum = 0
      let n = 0
      for (let i = 0; i + 1 < win; i += 2) {
        const v = buf.readInt16LE(i)
        sum += v * v
        n++
      }
      return { durMs, rms: n ? Math.sqrt(sum / n) : 0 }
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/** Мягко останавливает рекордер: SIGINT (arecord финализирует WAV), затем SIGKILL. */
async function stopGracefully(pid: number): Promise<void> {
  try { process.kill(pid, "SIGINT") } catch { return }
  const t = Date.now()
  while (isAlive(pid) && Date.now() - t < 2500) await sleep(100)
  if (isAlive(pid)) {
    try { process.kill(pid, "SIGKILL") } catch {}
  }
}

export interface AutoStopOptions {
  /** Жёсткий предел записанного аудио, с. */
  maxAudioSeconds?: number
  /** Сколько тишины считать концом речи, мс. */
  silenceMs?: number
  /** Минимальная длина аудио для срабатывания авто-стопа, мс. */
  minAudioMs?: number
  pollMs?: number
}

export interface PttEndInfo {
  reason: "ended" | "silence" | "maxAudio" | "wall"
  audioMs: number
}

/**
 * Ждёт конца речи: останавливает запись, когда после голоса идёт тишина
 * (silenceMs), либо по достижении лимита аудио/времени. Остановка мягкая.
 */
export async function waitPushToTalkAuto(session: PttSession, opts: AutoStopOptions = {}): Promise<PttEndInfo> {
  const maxAudioMs = (opts.maxAudioSeconds ?? maxRecordSeconds()) * 1000
  const silenceMs = opts.silenceMs ?? 1500
  const minAudioMs = opts.minAudioMs ?? 1200
  const pollMs = opts.pollMs ?? 200
  // RDP отдаёт ~0.38x realtime — запас по настенному времени щедрый.
  const wallLimit = maxAudioMs * 4 + 20000

  const t0 = Date.now()
  let lastVoiceAt = 0
  let sawVoice = false
  let durMs = 0

  while (true) {
    if (!isAlive(session.pid)) return { reason: "ended", audioMs: durMs }

    const w = wavTail(session.file)
    if (w) {
      durMs = w.durMs
      if (w.rms >= SILENCE_RMS * 2) {
        sawVoice = true
        lastVoiceAt = Date.now()
      }
      if (durMs >= maxAudioMs) {
        await stopGracefully(session.pid)
        return { reason: "maxAudio", audioMs: durMs }
      }
      if (sawVoice && durMs >= minAudioMs && Date.now() - lastVoiceAt >= silenceMs) {
        await stopGracefully(session.pid)
        return { reason: "silence", audioMs: durMs }
      }
    }

    if (Date.now() - t0 > wallLimit) {
      await stopGracefully(session.pid)
      return { reason: "wall", audioMs: durMs }
    }
    await sleep(pollMs)
  }
}

export function pttFileSize(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Пересоздаёт аудиоканал WSLg (weston + pulseaudio) через интероп wsl.exe.
 * Тот же рецепт, что в fix-mic.sh: WSLGd перезапускает процессы сам.
 * Отключается через OPENCODE_VOICE_AUTO_RECOVER=0.
 */
export async function recoverMic($: any): Promise<boolean> {
  if ((process.env.OPENCODE_VOICE_AUTO_RECOVER ?? "1") === "0") return false
  const wsl = process.env.WSL_EXE || "/mnt/c/Windows/System32/wsl.exe"
  const sys = (cmd: string) => $`${wsl} --system -e sh -lc ${cmd}`.quiet()
  try {
    try { await sys("pkill -9 -x weston") } catch {}
    await sleep(Number(process.env.OPENCODE_VOICE_RECOVER_WAIT_WESTON || 8000))
    try { await sys("pkill -9 -x pulseaudio") } catch {}
    await sleep(Number(process.env.OPENCODE_VOICE_RECOVER_WAIT_PULSE || 5000))
    // Default source после сброса может уехать на RDPSink.monitor — вернём микрофон.
    try {
      const pulse = process.env.PULSE_SERVER || "unix:/mnt/wslg/PulseServer"
      await $`env PULSE_SERVER=${pulse} pactl set-default-source ${micSource()}`.quiet()
    } catch {}
    return true
  } catch {
    return false
  }
}
