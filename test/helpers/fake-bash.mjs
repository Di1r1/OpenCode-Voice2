// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
/**
 * Minimal Bun-`$` shim for E2E tests (Node has no Bun shell).
 *
 * Interpolates a tagged template into argv like Bun does (arrays spread into
 * separate args), then runs the command with child_process unless the command
 * name is stubbed. Stubs are matched on the first argv token:
 *   { name: "text" }            -> exit 0, stdout "text"
 *   { name: (args) => string }  -> exit 0, stdout of the function
 *   { name: null }              -> exit 127 (not found)
 */
import { spawn } from "node:child_process"
import fs from "node:fs"

export function makeFakeBash({ stubs = {} } = {}) {
  const stubbed = (cmd) => Object.prototype.hasOwnProperty.call(stubs, cmd)

  const runCmd = (argv) =>
    new Promise((resolve) => {
      const [cmd, ...args] = argv
      if (stubbed(cmd)) {
        const v = stubs[cmd]
        if (v === null) return resolve({ code: 127, stdout: "", stderr: `${cmd}: not found` })
        const out = typeof v === "function" ? v(args) : v
        return resolve({ code: 0, stdout: String(out ?? ""), stderr: "" })
      }
      const child = spawn(cmd, args, { env: process.env })
      let stdout = ""
      let stderr = ""
      child.stdout?.on("data", (d) => (stdout += d))
      child.stderr?.on("data", (d) => (stderr += d))
      child.on("error", (e) => resolve({ code: 127, stdout: "", stderr: String(e?.message || e) }))
      child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }))
    })

  const $ = (strings, ...values) => {
    // Build one string with interpolated values wrapped in NUL sentinels, then
    // tokenize on whitespace outside sentinels (values stay one token, may glue
    // to adjacent literal text, e.g. `LD_LIBRARY_PATH=${ld}`).
    let s = ""
    strings.forEach((seg, i) => {
      s += seg
      if (i >= values.length) return
      const v = values[i]
      if (Array.isArray(v)) s += v.map((x) => `\x00${x}\x00`).join(" ")
      else s += `\x00${String(v)}\x00`
    })
    const argv = []
    let cur = ""
    let inValue = false
    for (const ch of s) {
      if (ch === "\x00") {
        inValue = !inValue
        continue
      }
      if (!inValue && /\s/.test(ch)) {
        if (cur) argv.push(cur)
        cur = ""
        continue
      }
      cur += ch
    }
    if (cur) argv.push(cur)

    const promise = () => runCmd(argv)
    return {
      argv,
      text: async () => {
        const r = await promise()
        if (r.code !== 0) throw Object.assign(new Error(`exit ${r.code}`), r)
        return r.stdout
      },
      quiet: async () => {
        const r = await promise()
        if (r.code !== 0) throw Object.assign(new Error(`exit ${r.code}`), r)
        return { stdout: r.stdout, stderr: r.stderr, exitCode: r.code }
      },
      then: (onFulfilled, onRejected) => promise().then(onFulfilled, onRejected),
    }
  }
  return $
}

/** Writes a WAV (mono PCM16) to `file`; `toneMs` of 440 Hz, the rest silence. */
export function writeWav(file, { seconds = 0.5, rate = 16000, toneMs = 0 } = {}) {
  const n = Math.round(seconds * rate)
  const data = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    const ms = (i / rate) * 1000
    const v = ms < toneMs ? Math.round(4000 * Math.sin((2 * Math.PI * 440 * i) / rate)) : 0
    data.writeInt16LE(v, i * 2)
  }
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write("WAVE", 8)
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36)
  header.writeUInt32LE(data.length, 40)
  fs.writeFileSync(file, Buffer.concat([header, data]))
  return file
}
