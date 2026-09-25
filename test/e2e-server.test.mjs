// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
/**
 * E2E: real STT server over HTTP (no mic, no model, no network).
 *
 * Spawns the actual `stt-server/stt_server.py` with a stub whisper-cli and
 * exercises the wire protocol: /health, CORS preflight, /transcribe with the
 * source header, the Origin guard and /beep. Skipped when Python/Flask are not
 * available (e.g. the Node-only CI job) so the same file is safe everywhere.
 */
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { writeWav } from "./helpers/fake-bash.mjs"

const PLUGIN_DIR = path.resolve(import.meta.dirname, "..")
const SERVER = path.join(PLUGIN_DIR, "stt-server", "stt_server.py")
const hasFlask = spawnSync("python3", ["-c", "import flask"], { stdio: "ignore" }).status === 0
const skip = hasFlask ? false : "python3/flask not available"

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ovi-e2e-server-"))
const WHISPER = path.join(TMP, "stub-whisper-cli.sh")
const MODEL = path.join(TMP, "ggml-stub.bin")
const REC_LOG = path.join(TMP, "voice-recognized.log")

fs.writeFileSync(WHISPER, `#!/bin/sh\necho "e2e сервер [шум] тест"\n`)
fs.writeFileSync(MODEL, "stub")
fs.chmodSync(WHISPER, 0o755)

let child
let base = ""

const freePort = () =>
  new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })

test.before(async () => {
  if (skip) return
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  child = spawn(
    "python3",
    ["-u", SERVER, "--port", String(port), "--host", "127.0.0.1"],
    {
      cwd: PLUGIN_DIR,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENCODE_VOICE_STT_BACKEND: "whispercpp",
        OPENCODE_VOICE_HOST: "127.0.0.1",
        OPENCODE_VOICE_CUDA: "0",
        OPENCODE_VOICE_RATE_LIMIT: "600",
        OPENCODE_VOICE_RETAIN_SECONDS: "0",
        // The server kills stray `voice-ptt-` recorders on startup; keep it away
        // from the recorder E2E running in a parallel test process.
        OPENCODE_VOICE_STALE_CLEANUP: "0",
        OPENCODE_VOICE_TMP_DIR: path.join(TMP, "tmp"),
        OPENCODE_VOICE_RECOGNIZED_LOG: REC_LOG,
        WHISPER_CPP_BIN: WHISPER,
        WHISPER_CPP_MODEL: MODEL,
      },
    },
  )
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`)
      if (res.ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error("server did not become ready")
})

test.after(() => {
  if (child) child.kill("SIGTERM")
})

test("health reports the server version and backend", { skip, timeout: 30000 }, async () => {
  const body = await (await fetch(`${base}/health`)).json()
  assert.equal(body.status, "ok")
  assert.equal(body.backend, "whispercpp")
  assert.ok(body.version, "version field must be present")
})

test("CORS preflight allows the source header", { skip, timeout: 30000 }, async () => {
  const res = await fetch(`${base}/beep`, {
    method: "OPTIONS",
    headers: {
      Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "x-voice-source",
    },
  })
  assert.equal(res.status, 200)
  assert.match(res.headers.get("access-control-allow-headers") || "", /X-Voice-Source/i)
})

test("transcribe accepts a WAV and tags the log with source=button", { skip, timeout: 30000 }, async () => {
  const wav = path.join(TMP, "speech.wav")
  writeWav(wav, { seconds: 1, toneMs: 500 })
  const form = new FormData()
  form.append("audio", new Blob([fs.readFileSync(wav)], { type: "audio/wav" }), "speech.wav")
  const res = await fetch(`${base}/transcribe`, {
    method: "POST",
    headers: { "X-Voice-Source": "button" },
    body: form,
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.ok(body.text.includes("e2e сервер"), `unexpected text: ${body.text}`)
  assert.ok(!body.text.includes("[шум]"), "service markers must be stripped")
  await new Promise((r) => setTimeout(r, 100))
  assert.match(fs.readFileSync(REC_LOG, "utf8"), /source=button/)
})

test("foreign Origin is rejected for POST", { skip, timeout: 30000 }, async () => {
  const res = await fetch(`${base}/beep?freq=0`, {
    method: "POST",
    headers: { Origin: "https://evil.example" },
  })
  assert.equal(res.status, 403)
})

test("beep with freq=0 only logs", { skip, timeout: 30000 }, async () => {
  const res = await fetch(`${base}/beep?freq=0`)
  assert.equal(res.status, 200)
  assert.equal((await res.json()).freq, 0)
})
