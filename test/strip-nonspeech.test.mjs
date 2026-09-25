// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
// Тесты пост-обработки распознанного текста (stripNonSpeech).
//
// Кейсы лежат в shared/strip-cases.json — тот же файл использует pytest,
// поэтому TS и Python гарантированно ведут себя одинаково.
//
// Запуск: npm test

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { stripNonSpeech } from "../src/lib/text.ts"

const read = (rel) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"))

const cases = read("../shared/strip-cases.json")

for (const { label, in: input, out } of cases) {
  test(label, () => {
    assert.equal(stripNonSpeech(input), out)
  })
}

test("shared spec is present and complete", () => {
  const spec = read("../shared/stt-spec.json")
  assert.ok(Array.isArray(spec.nonSpeechKeywords) && spec.nonSpeechKeywords.length > 0)
  assert.ok(typeof spec.nonSpeechSymbols === "string" && spec.nonSpeechSymbols.length > 0)
  assert.ok(spec.silence?.peak > 0 && spec.silence?.rms > 0)
  assert.ok(Array.isArray(spec.whisperCppExtraFlags) && spec.whisperCppExtraFlags.length > 0)
  assert.ok(spec.defaultModelByDevice?.gpu && spec.defaultModelByDevice?.cpu)
})
