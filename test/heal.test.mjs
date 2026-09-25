// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { makeFakeBash } from "./helpers/fake-bash.mjs"
import { heal, resetHealCooldown, doctorScript } from "../src/lib/heal.ts"

function tmpProject(withDoctor = true) {
  const dir = mkdtempSync(path.join(tmpdir(), "heal-"))
  if (withDoctor) writeFileSync(path.join(dir, "doctor.sh"), "#!/bin/sh\nexit 0\n")
  return dir
}

test("doctorScript finds doctor.sh next to the project", () => {
  const dir = tmpProject()
  assert.equal(doctorScript(dir), path.join(dir, "doctor.sh"))
})

test("doctorScript returns null when doctor.sh is absent", () => {
  assert.equal(doctorScript(tmpProject(false)), null)
})

test("heal runs doctor.sh --fix when forced", async () => {
  const dir = tmpProject()
  const calls = []
  const $ = makeFakeBash({ stubs: { bash: (args) => { calls.push(args.join(" ")); return "" } } })
  resetHealCooldown()
  const res = await heal($, { directory: dir, force: true })
  assert.equal(res.healed, true)
  assert.ok(String(res.script).endsWith("doctor.sh"))
  assert.equal(calls.length, 1)
  assert.ok(calls[0].endsWith("--fix"))
})

test("auto-heal is skipped when disabled", async () => {
  const dir = tmpProject()
  const calls = []
  const $ = makeFakeBash({ stubs: { bash: (args) => { calls.push(args); return "" } } })
  const res = await heal($, { directory: dir, env: { OPENCODE_VOICE_AUTO_HEAL: "0" } })
  assert.equal(res.healed, false)
  assert.equal(res.skipped, "disabled")
  assert.equal(calls.length, 0)
})

test("auto-heal honors the cooldown", async () => {
  const dir = tmpProject()
  const $ = makeFakeBash({ stubs: { bash: () => "" } })
  resetHealCooldown()
  const t = 1_000_000
  const first = await heal($, { directory: dir, env: {}, now: () => t })
  assert.equal(first.healed, true)
  const blocked = await heal($, { directory: dir, env: {}, now: () => t + 10_000 })
  assert.equal(blocked.healed, false)
  assert.equal(blocked.skipped, "cooldown")
  const allowed = await heal($, { directory: dir, env: {}, now: () => t + 91_000 })
  assert.equal(allowed.healed, true)
})
