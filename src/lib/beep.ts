// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
/**
 * Короткий звуковой сигнал для индикации: старт записи, конец записи,
 * готовность распознавания.
 *
 * WAV генерируется в /tmp (кэшируется) и проигрывается через PulseAudio/ALSA.
 * Best-effort: если проиграть не удалось — молча ничего не делаем.
 */

import { existsSync, writeFileSync } from "node:fs"

const RATE = 44100

function makeBeep(path: string, freq: number, ms: number): void {
  const n = Math.floor((RATE * ms) / 1000)
  const data = Buffer.alloc(n * 2)
  const fade = Math.max(1, Math.floor(RATE * 0.005))
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / fade, (n - i) / (fade * 2))
    const v = Math.sin((2 * Math.PI * freq * i) / RATE) * 12000 * env
    data.writeInt16LE(Math.round(v), i * 2)
  }
  const h = Buffer.alloc(44)
  h.write("RIFF", 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write("WAVE", 8)
  h.write("fmt ", 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(RATE, 24)
  h.writeUInt32LE(RATE * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write("data", 36)
  h.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([h, data]))
}

export async function beep($: any, freq = 880, ms = 120): Promise<void> {
  try {
    const file = `/tmp/voice-beep-${freq}-${ms}.wav`
    if (!existsSync(file)) makeBeep(file, freq, ms)
    try {
      await $`aplay -D pulse -q ${file}`.quiet()
      return
    } catch {}
    try {
      await $`paplay ${file}`.quiet()
      return
    } catch {}
    try {
      await $`ffplay -nodisp -autoexit -loglevel quiet ${file}`.quiet()
    } catch {}
  } catch {
    // сигнал best-effort
  }
}
