// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { statePath, loadState, saveState, resolveState, envOverride } from "../src/lib/state.ts"

const DEFAULTS = { backend: "local", language: "ru", device: "auto" }

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), "ovi-state-"))
  return { file: join(dir, "nested", "state.json"), dir }
}

test("statePath: default is ~/.config/opencode-voice/state.json", () => {
  assert.equal(
    statePath({}, "/home/u"),
    "/home/u/.config/opencode-voice/state.json",
  )
})

test("statePath: OPENCODE_VOICE_STATE_FILE wins", () => {
  assert.equal(statePath({ OPENCODE_VOICE_STATE_FILE: "/tmp/x.json" }, "/home/u"), "/tmp/x.json")
})

test("loadState: missing file -> {}", () => {
  const { file, dir } = tmpFile()
  try {
    assert.deepEqual(loadState(file), {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("loadState: broken JSON / wrong types -> {}", () => {
  const { dir } = tmpFile()
  const file = join(dir, "state.json")
  try {
    writeFileSync(file, "{not json", "utf8")
    assert.deepEqual(loadState(file), {})
    writeFileSync(file, JSON.stringify({ backend: 5, language: "", device: "cpu" }), "utf8")
    assert.deepEqual(loadState(file), { device: "cpu" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("saveState + loadState: roundtrip and merge", () => {
  const { file, dir } = tmpFile()
  try {
    assert.equal(saveState({ backend: "api" }, file), true)
    assert.deepEqual(loadState(file), { backend: "api" })
    assert.equal(saveState({ language: "en" }, file), true)
    assert.deepEqual(loadState(file), { backend: "api", language: "en" })
    assert.equal(saveState({ backend: "local" }, file), true)
    assert.deepEqual(loadState(file), { backend: "local", language: "en" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("resolveState: defaults when nothing saved", () => {
  const { file, dir } = tmpFile()
  try {
    assert.deepEqual(resolveState(DEFAULTS, {}, file), DEFAULTS)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("resolveState: file overrides defaults, env overrides file", () => {
  const { file, dir } = tmpFile()
  try {
    saveState({ backend: "api", device: "gpu" }, file)
    assert.deepEqual(resolveState(DEFAULTS, {}, file), {
      backend: "api", language: "ru", device: "gpu",
    })
    assert.deepEqual(
      resolveState(DEFAULTS, { OPENCODE_VOICE_DEVICE: "cpu" }, file),
      { backend: "api", language: "ru", device: "cpu" },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("envOverride: true only when the variable is set", () => {
  assert.equal(envOverride("backend", {}), false)
  assert.equal(envOverride("backend", { OPENCODE_VOICE_BACKEND: "api" }), true)
  assert.equal(envOverride("language", { OPENCODE_VOICE_DEVICE: "cpu" }), false)
})
