// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  cudaLibDirs,
  defaultModelSize,
  hasCuda,
  ldLibraryPath,
  silencePeak,
  silenceRms,
  whisperBin,
  whisperDir,
  whisperHome,
  whisperModelPath,
} from "../src/lib/whisper.ts"

function tmpHome(label) {
  return mkdtempSync(path.join(tmpdir(), `ovi-${label}-`))
}

test("home and whisper dir default under the given home", () => {
  const home = "/home/someone"
  assert.equal(whisperHome({}, home), path.join(home, ".local/share/opencode-voice"))
  assert.equal(whisperDir({}, home), path.join(home, ".local/share/opencode-voice/whisper"))
})

test("home and whisper dir honor env overrides", () => {
  const env = { OPENCODE_VOICE_HOME: "/data/ovi", OPENCODE_VOICE_WHISPER_DIR: "/opt/whisper" }
  assert.equal(whisperHome(env, "/home/x"), "/data/ovi")
  assert.equal(whisperDir(env, "/home/x"), "/opt/whisper")
})

test("model path: explicit WHISPER_CPP_MODEL wins, otherwise ggml-<size>.bin", () => {
  const home = tmpHome("model")
  assert.equal(whisperModelPath("small", {}, home), path.join(home, ".local/share/opencode-voice/whisper/ggml-small.bin"))
  assert.equal(whisperModelPath("medium", { WHISPER_CPP_MODEL: "/m/ggml.bin" }, home), "/m/ggml.bin")
})

test("default model size: explicit env > cuda medium > cpu small", () => {
  assert.equal(defaultModelSize({}, true), "medium")
  assert.equal(defaultModelSize({}, false), "small")
  assert.equal(defaultModelSize({ WHISPER_MODEL: "base" }, true), "base")
  assert.equal(defaultModelSize({ WHISPER_CPP_MODEL_SIZE: "large" }, true), "large")
  assert.equal(defaultModelSize({ WHISPER_CPP_MODEL_SIZE: "large", WHISPER_MODEL: "base" }, true), "large")
})

test("cuda is off when OPENCODE_VOICE_CUDA=0", () => {
  const home = tmpHome("nocuda")
  mkdirSync(path.join(home, ".local/share/opencode-voice/whisper"), { recursive: true })
  assert.equal(hasCuda({ OPENCODE_VOICE_CUDA: "0" }, home), false)
})

test("cuda lib dirs discover versioned cuda-* directories and CUDA_HOME", () => {
  const home = tmpHome("cudalibs")
  const versioned = path.join(home, "cuda-12.9", "lib64")
  mkdirSync(versioned, { recursive: true })
  const extra = path.join(home, "cuda-home", "lib64")
  mkdirSync(extra, { recursive: true })

  const dirs = cudaLibDirs({ CUDA_HOME: path.join(home, "cuda-home") }, home)
  assert.ok(dirs.includes(versioned), `expected ${versioned} in ${dirs}`)
  assert.ok(dirs.includes(extra), `expected ${extra} in ${dirs}`)
})

test("hasCuda detects libcudart in a versioned cuda dir", () => {
  const home = tmpHome("cudart")
  const lib64 = path.join(home, "cuda-12.9", "lib64")
  mkdirSync(lib64, { recursive: true })
  writeFileSync(path.join(lib64, "libcudart.so"), "")
  assert.equal(hasCuda({}, home), true)
})

test("whisperBin finds the CLI in the whisper dir", () => {
  const home = tmpHome("bin")
  const dir = path.join(home, ".local/share/opencode-voice/whisper/bin")
  mkdirSync(dir, { recursive: true })
  const cli = path.join(dir, "whisper-cli")
  writeFileSync(cli, "")
  assert.equal(whisperBin({}, home), cli)
  assert.equal(whisperBin({}, tmpHome("nobin")), null)
})

test("ld library path starts with the bin dir and includes cuda dirs", () => {
  const home = tmpHome("ld")
  const lib64 = path.join(home, "cuda-12.6", "lib64")
  mkdirSync(lib64, { recursive: true })
  const ld = ldLibraryPath({}, home)
  assert.ok(ld.startsWith(path.join(home, ".local/share/opencode-voice/whisper/bin")), ld)
  assert.ok(ld.includes(lib64), ld)
})

test("silenceRms comes from the shared spec and env wins", () => {
  // shared/stt-spec.json silence.rms = 80
  assert.equal(silenceRms({}), 80)
  assert.equal(silenceRms({ OPENCODE_VOICE_SILENCE_RMS: "120" }), 120)
  // мусор/ноль игнорируются -> значение из спека
  assert.equal(silenceRms({ OPENCODE_VOICE_SILENCE_RMS: "abc" }), 80)
  assert.equal(silenceRms({ OPENCODE_VOICE_SILENCE_RMS: "0" }), 80)
})

test("silencePeak comes from the shared spec and env wins", () => {
  // shared/stt-spec.json silence.peak = 700
  assert.equal(silencePeak({}), 700)
  assert.equal(silencePeak({ OPENCODE_VOICE_SILENCE_PEAK: "500" }), 500)
  // мусор/ноль игнорируются -> значение из спека
  assert.equal(silencePeak({ OPENCODE_VOICE_SILENCE_PEAK: "abc" }), 700)
  assert.equal(silencePeak({ OPENCODE_VOICE_SILENCE_PEAK: "0" }), 700)
})
