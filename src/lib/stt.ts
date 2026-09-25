// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
/**
 * Speech-to-text: два бэкенда.
 *
 * api   — OpenAI Whisper API (требует OPENAI_API_KEY). Требует internet.
 * local — локальный: faster-whisper (pip), whisper.cpp или vosk.
 *        faster-whisper предпочтительнее — не требует torch, работает на CPU.
 *        Если ни одно не доступно — бросает понятную ошибку.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { config } from "./config.ts"
import { CPU_MODEL_SIZE, GPU_MODEL_SIZE, WHISPER_CPP_EXTRA_FLAGS, defaultModelSize, hasCuda, ldLibraryPath, silencePeak, silenceRms, whisperBin, whisperModelPath } from "./whisper.ts"

// Диагностика: какой бэкенд реально использовался (`/tmp/opencode/voice-stt.log`).
function note(backend: string, info: string): void {
  try {
    appendFileSync(
      "/tmp/opencode/voice-stt.log",
      `${new Date().toISOString()} ${backend} ${info}\n`,
    )
  } catch {
    // диагностика best-effort
  }
}

// Порог тишины: на тишине/шуме Whisper галлюцинирует, поэтому не тратим на неё проход.
// Канонические silencePeak()/silenceRms() (env + shared/stt-spec.json).

function wavInfo(file: string): { peak: number; rms: number; durSec: number } | null {
  try {
    const buf = readFileSync(file)
    if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF") return null
    let pos = 12
    let dataOff = -1
    let dataLen = 0
    let bits = 16
    let bytesPerSec = 32000
    while (pos + 8 <= buf.length) {
      const id = buf.toString("ascii", pos, pos + 4)
      const size = buf.readUInt32LE(pos + 4)
      if (id === "fmt ") {
        bits = buf.readUInt16LE(pos + 22)
        const ch = buf.readUInt16LE(pos + 10)
        const sr = buf.readUInt32LE(pos + 12)
        if (ch > 0 && sr > 0 && bits > 0) bytesPerSec = ch * sr * (bits / 8)
      }
      if (id === "data") {
        dataOff = pos + 8
        dataLen = Math.min(size, buf.length - dataOff)
        break
      }
      pos += 8 + size + (size % 2)
    }
    if (dataOff < 0 || bits !== 16) return null
    let peak = 0
    let sum = 0
    let n = 0
    for (let i = 0; i + 1 < dataLen; i += 2) {
      const v = buf.readInt16LE(dataOff + i)
      const a = Math.abs(v)
      if (a > peak) peak = a
      sum += v * v
      n++
    }
    return { peak, rms: n ? Math.sqrt(sum / n) : 0, durSec: dataLen / bytesPerSec }
  } catch {
    return null
  }
}

function isSilentWav(file: string): boolean {
  const lv = wavInfo(file)
  if (!lv) return false
  const silent = lv.peak < silencePeak() && lv.rms < silenceRms()
  note("levels", `peak=${lv.peak.toFixed(0)} rms=${lv.rms.toFixed(0)} silent=${silent}`)
  return silent
}

// Какой бэкенд/модель реально отработали (для unified-лога).
let lastBackend = ""
let lastModel = ""

/**
 * Единый лог распознанного текста: видно, откуда пришёл текст (source=command|button|api).
 * Файл: OPENCODE_VOICE_RECOGNIZED_LOG или /tmp/opencode/voice-recognized.log.
 */
export function logRecognized(source: string, text: string, language: string, file: string): void {
  try {
    const info = wavInfo(file)
    const dur = info ? info.durSec.toFixed(2) : "0.00"
    const esc = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")
    const logPath = process.env.OPENCODE_VOICE_RECOGNIZED_LOG || "/tmp/opencode/voice-recognized.log"
    appendFileSync(
      logPath,
      `${new Date().toISOString()} source=${source} backend=${lastBackend || "?"} model=${lastModel || "?"} ` +
        `lang=${language} dur=${dur}s text="${esc}"\n`,
    )
  } catch {
    // логирование best-effort
  }
}

// Пост-обработка текста вынесена в ./text (тестируется напрямую).
export { stripNonSpeech } from "./text.ts"

export interface TranscribeOptions {
  backend: "local" | "api"
  language: string
  file: string
  $: any
  /** auto (по умолчанию) | gpu | cpu. auto: GPU, при неудаче/отсутствии — CPU. */
  device?: string
  /** Откуда пришёл текст: command (/voice) или button (расширение). */
  source?: string
}

export async function transcribe(opts: TranscribeOptions): Promise<string> {
  const { backend, language, file, $, device, source } = opts

  const text = backend === "api"
    ? await transcribeApi({ file, language, $ })
    : await transcribeLocal({ file, language, device, $ })
  logRecognized(source || "command", text, language, file)
  return text
}

// ---------------------------------------------------------------------------
// Облачный бэкенд: OpenAI Whisper API
// ---------------------------------------------------------------------------

async function transcribeApi(opts: { file: string; language: string; $: any }): Promise<string> {
  const { file, language, $ } = opts

  if (!config.openaiApiKey) {
    throw new Error(
      "Для бэкенда 'api' нужен OPENAI_API_KEY. " +
      "Установи его в opencode.json: env.OPENAI_API_KEY или экспортуй в среду.",
    )
  }

  // whisper-1 не поддерживает language=auto — фильтруем
  const lang = language === "auto" ? undefined : language

  const { OpenAI } = await import("openai")
  const openai = new OpenAI({ apiKey: config.openaiApiKey })
  lastBackend = "openai"
  lastModel = config.whisperModel

  const fs = await import("node:fs/promises")
  const path = await import("node:path")
  const audio = await fs.readFile(file)

  const res = await openai.audio.transcriptions.create({
    file: await OpenAI.toFile(audio, path.basename(file)),
    model: config.whisperModel,
    ...(lang ? { language: lang } : {}),
    response_format: "text",
  })

  return String(res).trim()
}

// ---------------------------------------------------------------------------
// Локальный бэкенд
// ---------------------------------------------------------------------------

async function transcribeLocal(opts: { file: string; language: string; device?: string; $: any }): Promise<string> {
  const { file, language, $ } = opts
  const pref = (process.env.OPENCODE_VOICE_STT_BACKEND || "").toLowerCase()

  if (isSilentWav(file)) {
    throw new Error("речь не распознана: тишина (проверь микрофон / RDP-источник)")
  }

  // Устройство: auto (по умолчанию) | gpu | cpu.
  // OPENCODE_VOICE_STT_BACKEND оставлен для совместимости.
  let device = (opts.device || process.env.OPENCODE_VOICE_DEVICE || "auto").toLowerCase()
  if (["faster-whisper", "cpu", "faster_whisper"].includes(pref)) device = "cpu"
  if (["whispercpp", "gpu", "cuda"].includes(pref)) device = "gpu"
  if (!["auto", "gpu", "cpu"].includes(device)) device = "auto"

  // Есть ли CUDA-драйвер/рантайм — по библиотеке (libcuda/libcudart), а не по
  // бинарнику whisper-cli: сборка с CUDA есть, а GPU может не быть — тогда
  // whisper.cpp не запустится и надо уходить на CPU.
  const cuda = hasCuda()
  const size = defaultModelSize(process.env, cuda)
  const bin = whisperBin()
  const sizeModel = whisperModelPath(size)
  const gpuDefaultModel = whisperModelPath(GPU_MODEL_SIZE)
  const cpuDefaultModel = whisperModelPath(CPU_MODEL_SIZE)
  // GPU: выбранный размер, иначе GPU-дефолт, иначе CPU-дефолт (из shared/stt-spec.json).
  const gpuModel = existsSync(sizeModel) ? sizeModel : (existsSync(gpuDefaultModel) ? gpuDefaultModel : cpuDefaultModel)
  const cpuModel = existsSync(cpuDefaultModel) ? cpuDefaultModel : gpuModel

  const preferGpu = device === "gpu" || (device === "auto" && cuda)
  const haveWhisperCpp = !!bin && existsSync(gpuModel)

  // 1) whisper.cpp на GPU — только если есть CUDA (или явно попросили gpu).
  if (preferGpu && haveWhisperCpp) {
    try {
      return await transcribeWhisperCpp({
        file, language, $, cli: bin!, model: gpuModel,
      })
    } catch (e) {
      // Явный gpu — не прячем ошибку. auto — молча уходим на CPU.
      if (device === "gpu") throw e
    }
  }

  // 2) faster-whisper (CPU, рекомендуется: не требует torch).
  if (device !== "gpu" && await hasFasterWhisper($)) {
    return transcribeFasterWhisper({ file, language, $ })
  }

  // 3) whisper.cpp на CPU — если GPU нет, а faster-whisper не установлен.
  if (device !== "gpu" && bin && existsSync(cpuModel)) {
    try {
      return await transcribeWhisperCpp({ file, language, $, cli: bin, model: cpuModel })
    } catch {
      // уходим к остальным фолбэкам
    }
  }

  // 4) whisper.cpp CLI из PATH (whisper-cli / main / whisper)
  const whisperCli = await which($, "whisper-cli") || await which($, "main") || await which($, "whisper")
  if (whisperCli) {
    return transcribeWhisperCpp({ file, language, $, cli: whisperCli })
  }

  // 5) Python whisper (openai-whisper)
  if (await hasPythonWhisper($)) {
    return transcribePythonWhisper({ file, language, $ })
  }

  // 6) vosk
  if (await hasVosk($)) {
    return transcribeVosk({ file, language, $ })
  }

  throw new Error(
    "Локальный бэкенд не настроен. Установи один из:\n" +
    "  • pip install faster-whisper (рекомендуется)\n" +
    "  • whisper.cpp: собери CLI + модель (пути можно задать через WHISPER_CPP_BIN и WHISPER_CPP_MODEL)\n" +
    "  • pip install openai-whisper (требуется torch)\n" +
    "  • pip install vosk\n" +
    "Или переключись на облачный: /voice backend api",
  )
}

async function which($: any, cmd: string): Promise<string | null> {
  try {
    const out = await $`command -v ${cmd}`.text()
    return out.trim() || null
  } catch {
    return null
  }
}

async function hasFasterWhisper($: any): Promise<boolean> {
  try {
    const out = await $`python3 -c "from faster_whisper import WhisperModel; print('ok')"`.text()
    return out.includes("ok")
  } catch {
    return false
  }
}

async function hasPythonWhisper($: any): Promise<boolean> {
  try {
    const out = await $`python3 -c "import whisper; print('ok')"`.text()
    return out.includes("ok")
  } catch {
    return false
  }
}

async function hasVosk($: any): Promise<boolean> {
  try {
    const out = await $`python3 -c "import vosk; print('ok')"`.text()
    return out.includes("ok")
  } catch {
    return false
  }
}

async function transcribeFasterWhisper(opts: { file: string; language: string; $: any }): Promise<string> {
  const { file, language, $ } = opts
  const modelSize = defaultModelSize()
  lastBackend = "faster-whisper"
  lastModel = modelSize
  note("faster-whisper", `${modelSize} ${file}`)
  // Python ждёт None, а не null — поэтому маппим auto -> None явно.
  const langPy = language === "auto" ? "None" : JSON.stringify(language)
  const initialPrompt = process.env.WHISPER_INITIAL_PROMPT || ""
  // Качество авто-определения языка (применяется когда language=auto/None).
  const detectSegments = Number(process.env.WHISPER_LANG_DETECT_SEGMENTS ?? 3) || 3
  const detectThreshold = Number(process.env.WHISPER_LANG_DETECT_THRESHOLD ?? 0.6) || 0.6
  // Скорость распознавания.
  const beamSize = Number(process.env.WHISPER_BEAM_SIZE ?? 1) || 1
  const vad = !["0", "false", "no", "off", ""].includes(
    String(process.env.WHISPER_VAD ?? "1").toLowerCase(),
  )
  const code = `
import sys
from faster_whisper import WhisperModel
model = WhisperModel(${JSON.stringify(modelSize)}, device="cpu", compute_type="int8")
segments, info = model.transcribe(
    sys.argv[1],
    language=${langPy},
    beam_size=${beamSize},
    vad_filter=${vad ? "True" : "False"},
    vad_parameters=dict(min_silence_duration_ms=300),
    initial_prompt=${initialPrompt ? JSON.stringify(initialPrompt) : "None"},
    condition_on_previous_text=False,
    temperature=0.0,
    language_detection_segments=${detectSegments},
    language_detection_threshold=${detectThreshold},
)
print("".join(s.text for s in segments))
`
  const out = await runPythonFile($, code, file)
  return out.trim()
}

async function transcribeWhisperCpp(opts: { file: string; language: string; $: any; cli: string; model?: string }): Promise<string> {
  const { file, language, $, cli } = opts
  const model = opts.model || process.env.WHISPER_MODEL_PATH || whisperModelPath(defaultModelSize())
  lastBackend = "whispercpp"
  lastModel = path.basename(model)
  note("whispercpp", `${cli} ${model}`)
  const lang = language && language !== "auto" ? language : "auto"
  // CUDA-рантайм + драйвер WSL (каталоги находятся автоматически).
  const ld = ldLibraryPath()
  const out = await $`env LD_LIBRARY_PATH=${ld} ${cli} -m ${model} -f ${file} -l ${lang} -nt -np ${WHISPER_CPP_EXTRA_FLAGS}`.text()
  const text = out.trim()
  if (!text) throw new Error("whisper.cpp не выдал текст")
  return text
}

async function transcribePythonWhisper(opts: { file: string; language: string; $: any }): Promise<string> {
  const { file, language, $ } = opts
  const langPy = language === "auto" ? "None" : JSON.stringify(language)
  const modelSize = defaultModelSize()
  lastBackend = "python-whisper"
  lastModel = modelSize
  const code = `
import whisper, sys, json
model = whisper.load_model(${JSON.stringify(modelSize)})
res = model.transcribe(sys.argv[1], language=${langPy}, verbose=False)
print(res["text"])
`
  const out = await runPythonFile($, code, file)
  return out.trim()
}

async function transcribeVosk(opts: { file: string; language: string; $: any }): Promise<string> {
  const { file, language, $ } = opts
  const modelPath = process.env.VOSK_MODEL_PATH || "./model"
  lastBackend = "vosk"
  lastModel = modelPath
  const code = `
import json, sys
from vosk import Model, KaldiRecognizer
import wave
model = Model(${JSON.stringify(modelPath)})
wf = wave.open(sys.argv[1], "rb")
rec = KaldiRecognizer(model, wf.getframerate())
rec.SetLanguage(${JSON.stringify(language === "ru" ? "ru" : "en")})
res = []
while True:
    data = wf.readframes(4000)
    if len(data) == 0: break
    if rec.AcceptWaveform(data):
        res.append(json.loads(rec.Result())["text"])
print(" ".join(res).strip())
`
  const out = await runPythonFile($, code, file)
  return out.trim()
}

/**
 * Запускает многострочный Python-код через временный файл.
 * `python3 -c <многострочный код>` ломается на кавычках/переносах,
 * поэтому пишем код в файл (по умолчанию в RAM-каталог) и передаём аудиофайл как argv[1].
 */
async function runPythonFile($: any, code: string, audioFile: string): Promise<string> {
  const fs = await import("node:fs/promises")
  const name = `voice-stt-${Date.now()}-${Math.random().toString(36).slice(2)}.py`
  const ramDir = process.env.OPENCODE_VOICE_TMP_DIR || "/dev/shm/opencode-voice"
  let script = path.join(os.tmpdir(), name)
  try {
    await fs.mkdir(ramDir, { recursive: true })
    const ramScript = path.join(ramDir, name)
    await fs.writeFile(ramScript, code, "utf8")
    script = ramScript
  } catch {
    await fs.writeFile(script, code, "utf8")
  }
  try {
    const out = await $`python3 ${script} ${audioFile}`.text()
    return out
  } finally {
    try { await fs.unlink(script) } catch {}
  }
}