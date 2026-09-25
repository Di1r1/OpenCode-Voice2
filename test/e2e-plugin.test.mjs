// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
/**
 * E2E: plugin capture path (recorder -> WAV -> STT -> text), fully hermetic.
 *
 * Real `src/lib/recorder.ts` + `src/lib/stt.ts` run in Node with a fake Bun-`$`
 * and a stub recorder / stub whisper-cli (Node scripts), so there is no mic, no
 * model and no network. Covers: start -> silence auto-stop -> graceful SIGINT ->
 * finalized WAV header -> whisper.cpp CLI invocation -> recognized-text log.
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { makeFakeBash, writeWav } from "./helpers/fake-bash.mjs"

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ovi-e2e-"))
const RECORDER = path.join(TMP, "stub-recorder.mjs")
const WHISPER = path.join(TMP, "stub-whisper-cli.mjs")
const MODEL = path.join(TMP, "ggml-stub.bin")
const REC_LOG = path.join(TMP, "voice-recognized.log")
const STT_TEXT = "e2e проверка: [музыка] текст"

const RECORDER_SRC = `#!/usr/bin/env node
import fs from "node:fs"
const args = process.argv.slice(2)
const dIdx = args.indexOf("-d")
const dur = dIdx >= 0 ? Number(args[dIdx + 1]) : 5
const out = args[args.length - 1]
const rate = 16000
const step = 100
const maxBytes = Math.round(dur * rate * 2)
const header = Buffer.alloc(44)
const writeHeader = (dataLen) => {
  header.write("RIFF", 0); header.writeUInt32LE(36 + dataLen, 4); header.write("WAVE", 8)
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34)
  header.write("data", 36); header.writeUInt32LE(dataLen, 40)
}
// arecord-like: declare the full size upfront (so a killed process leaves a stale header)
writeHeader(maxBytes)
const fd = fs.openSync(out, "w+")
fs.writeSync(fd, header, 0, 44, 0)
let written = 0
let t = 0
let done = false
const finish = () => {
  if (done) return
  done = true
  clearInterval(timer)
  writeHeader(written)               // finalize on SIGINT
  fs.writeSync(fd, header, 0, 44, 0)
  fs.closeSync(fd)
  process.exit(0)
}
const chunk = (tone) => {
  const n = Math.round((rate * step) / 1000)
  const b = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    const idx = written / 2 + i
    b.writeInt16LE(tone ? Math.round(4000 * Math.sin((2 * Math.PI * 440 * idx) / rate)) : 0, i * 2)
  }
  return b
}
const timer = setInterval(() => {
  const b = chunk(t < 500)           // 500 ms of speech, then silence
  fs.writeSync(fd, b, 0, b.length, 44 + written)
  written += b.length
  t += step
  if (written >= maxBytes) finish()
}, step)
process.on("SIGINT", finish)
process.on("SIGTERM", finish)
`

fs.writeFileSync(RECORDER, RECORDER_SRC)
fs.writeFileSync(WHISPER, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(STT_TEXT + "\n")})\n`)
fs.writeFileSync(MODEL, "stub")
fs.chmodSync(RECORDER, 0o755)
fs.chmodSync(WHISPER, 0o755)

process.env.OPENCODE_VOICE_RECORDER_BIN = RECORDER
process.env.OPENCODE_VOICE_TMP_DIR = path.join(TMP, "rec")
process.env.OPENCODE_VOICE_RETAIN_SECONDS = "0"
process.env.OPENCODE_VOICE_MAX_RECORD_SECONDS = "10"
process.env.OPENCODE_VOICE_DEVICE = "cpu"
process.env.OPENCODE_VOICE_CUDA = "0"
process.env.OPENCODE_VOICE_HOME = TMP
process.env.WHISPER_CPP_BIN = WHISPER
process.env.WHISPER_CPP_MODEL = MODEL
process.env.OPENCODE_VOICE_RECOGNIZED_LOG = REC_LOG
delete process.env.OPENCODE_VOICE_KEEP_AUDIO
delete process.env.OPENCODE_VOICE_SOURCE

const rec = await import("../src/lib/recorder.ts")
const stt = await import("../src/lib/stt.ts")

const $ = makeFakeBash({
  stubs: {
    command: "",     // `command -v` finds nothing
    test: null,      // `test -x /usr/bin/...` fails -> which() returns null
    pkill: "",
    python3: "",     // hasFasterWhisper() -> false
  },
})

function wavHeader(file) {
  const buf = fs.readFileSync(file)
  let pos = 12
  while (pos + 8 <= 64) {
    const id = buf.toString("ascii", pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === "data") return { declared: size, actual: buf.length - (pos + 8) }
    pos += 8 + size + (size % 2)
  }
  throw new Error("no data chunk")
}

test("recorder: silence auto-stop stops gracefully and finalizes the WAV", { timeout: 30000 }, async () => {
  const session = await rec.startPushToTalk($, { maxSeconds: 10 })
  assert.equal(session.backend, "custom")
  const t0 = Date.now()
  const info = await rec.waitPushToTalkAuto(session, {
    maxAudioSeconds: 10,
    silenceMs: 300,
    minAudioMs: 200,
  })
  assert.equal(info.reason, "silence", "should stop by silence, not by the hard cap")
  assert.ok(Date.now() - t0 < 8000, "auto-stop should happen quickly")
  const { declared, actual } = wavHeader(session.file)
  assert.equal(declared, actual, "WAV header must be finalized (declared == actual)")
  assert.ok(rec.pttFileSize(session.file) > 44)
})

test("transcribe: plugin path runs whisper.cpp CLI and logs source=command", { timeout: 30000 }, async () => {
  const file = path.join(TMP, "speech.wav")
  writeWav(file, { seconds: 1, toneMs: 500 })
  const raw = await stt.transcribe({ backend: "local", language: "ru", file, $, device: "cpu", source: "command" })
  assert.ok(raw.includes("e2e проверка"), `unexpected text: ${raw}`)
  assert.equal(stt.stripNonSpeech(raw), "e2e проверка: текст")
  const log = fs.readFileSync(REC_LOG, "utf8")
  assert.match(log, /source=command/)
  assert.match(log, /backend=whispercpp/)
  assert.match(log, /lang=ru/)
})

test("transcribe: pure silence is rejected by the silence gate", { timeout: 30000 }, async () => {
  const file = path.join(TMP, "silence.wav")
  writeWav(file, { seconds: 0.5, toneMs: 0 })
  await assert.rejects(
    () => stt.transcribe({ backend: "local", language: "ru", file, $, device: "cpu", source: "command" }),
    /тишина/,
  )
})
