// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
// Тесты озвучки: cleanForSpeech/helpers.
//
// Канон — src/lib/text.ts (его же использует сервер/плагин). Браузерная копия
// живёт в extension/tts.js (сборщика нет, ESM в content-скриптах недоступен),
// поэтому здесь она загружается через node:vm, а те же shared/tts-cases.json
// прогоняются через обе реализации — копии не разъедутся молча.
//
// Запуск: npm test

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import vm from "node:vm"
import { cleanForSpeech as cleanCanon } from "../src/lib/text.ts"

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url))
const readJson = (rel) => JSON.parse(readFileSync(here(rel), "utf8"))

// Загружаем классический content-скрипт в песочницу без chrome/document —
// он отдаёт хелперы в globalThis.OpenCodeVoiceTTS и не запускает рантайм.
const sandbox = { console }
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(readFileSync(here("../extension/tts.js"), "utf8"), sandbox)
const TTS = sandbox.OpenCodeVoiceTTS

test("tts.js exposes helpers", () => {
  for (const name of ["cleanForSpeech", "detectLang", "pickVoice", "briefSentences", "chunkSentences", "utteranceBudget", "dedupKey", "comboMatches", "markedSpoken", "pickSpoken", "start"]) {
    assert.equal(typeof TTS[name], "function", `missing ${name}`)
  }
  assert.equal(TTS.DEFAULTS.ttsEngine, "browser", "engine defaults to the browser (opt-in server)")
})

// Кросс-паритет канона (text.ts) и браузерной копии (tts.js) на общих кейсах.
for (const { label, in: input, out, readCode } of readJson("../shared/tts-cases.json")) {
  test(`parity: ${label}`, () => {
    const opts = { readCode: readCode === true }
    const canon = cleanCanon(input, opts)
    const mirror = TTS.cleanForSpeech(input, opts)
    assert.equal(mirror, canon, "tts.js copy diverged from src/lib/text.ts")
    assert.equal(mirror, out)
  })
}

test("detectLang: cyrillic / latin / cjk", () => {
  assert.equal(TTS.detectLang("Привет, как дела?"), "ru-RU")
  assert.equal(TTS.detectLang("Hello world"), "en-US")
  assert.equal(TTS.detectLang("你好世界"), "zh-CN")
  assert.equal(TTS.detectLang(""), "en-US")
})

test("pickVoice: language + localOnly", () => {
  const voices = [
    { name: "ru-local", lang: "ru-RU", localService: true, default: true },
    { name: "ru-remote", lang: "ru_RU", localService: false },
    { name: "en-local", lang: "en-US", localService: true },
  ]
  assert.equal(TTS.pickVoice(voices, "ru-RU", { localOnly: true }).name, "ru-local")
  assert.equal(TTS.pickVoice(voices, "ru-RU", { localOnly: false }).name, "ru-local")
  assert.equal(TTS.pickVoice(voices, "en-US", { localOnly: true }).name, "en-local")
  assert.equal(TTS.pickVoice(voices, "de-DE", { localOnly: true }), null)
  assert.equal(TTS.pickVoice([{ lang: "ru-RU", localService: false }], "ru-RU", { localOnly: true }), null)
})

test("briefSentences: first N + errors (decision §10.3)", () => {
  assert.equal(TTS.briefSentences("A. B. C. D.", 2), "A. B.")
  assert.equal(
    TTS.briefSentences("Всё хорошо. Произошла ошибка X. Дальше.", 1),
    "Всё хорошо. Произошла ошибка X."
  )
  assert.equal(TTS.briefSentences("", 2), "")
})

test("chunkSentences splits long text without loss", () => {
  const long = Array.from({ length: 40 }, (_, i) => `Предложение номер ${i}.`).join(" ")
  const chunks = TTS.chunkSentences(long, 80)
  assert.ok(chunks.length >= 2)
  assert.ok(chunks.every((c) => c.length <= 80))
  assert.equal(chunks.join(" ").replace(/\s+/g, " "), long.replace(/\s+/g, " "))
})

test("utteranceBudget scales with length/rate and is clamped", () => {
  const short = TTS.utteranceBudget("Привет.", 1.0)
  const long = TTS.utteranceBudget("Предложение. ".repeat(60), 1.0)
  assert.ok(long > short, "longer text gets a bigger budget")
  assert.ok(TTS.utteranceBudget("x".repeat(100), 2.0) < TTS.utteranceBudget("x".repeat(100), 1.0), "higher rate shrinks the budget")
  assert.ok(short >= 10000 && long <= 60000, "budget is clamped to [10s, 60s]")
  assert.equal(TTS.utteranceBudget("", 1.0), 10000, "empty text gets the floor")
})

test("dedupKey stable and distinct", () => {
  assert.equal(TTS.dedupKey("m1", "текст"), TTS.dedupKey("m1", "текст"))
  assert.notEqual(TTS.dedupKey("m1", "текст"), TTS.dedupKey("m2", "текст"))
  assert.notEqual(TTS.dedupKey("m1", "текст"), TTS.dedupKey("m1", "другой"))
})

test("comboMatches ctrl+c", () => {
  assert.ok(TTS.comboMatches({ key: "c", code: "KeyC", ctrlKey: true }, "ctrl+c"))
  assert.ok(!TTS.comboMatches({ key: "c", code: "KeyC", ctrlKey: false }, "ctrl+c"))
  assert.ok(!TTS.comboMatches({ key: "v", code: "KeyV", ctrlKey: true }, "ctrl+c"))
})

test("shared tts spec section is present and complete", () => {
  const spec = readJson("../shared/stt-spec.json")
  assert.ok(spec.tts && typeof spec.tts === "object")
  assert.ok(typeof spec.tts.engine === "string" && spec.tts.engine.length > 0)
  assert.ok(Number.isFinite(spec.tts.maxChars) && spec.tts.maxChars > 0)
  assert.ok(Number.isFinite(spec.tts.briefSentences) && spec.tts.briefSentences > 0)
  assert.ok(spec.tts.mode === "brief" || spec.tts.mode === "full")
  assert.ok(typeof spec.tts.lang === "string" && spec.tts.lang.length > 0)
})

// --- Управление озвучкой меткой 🔈 -------------------------------------
// Ассистент сам решает, что произносить: помеченная строка говорится,
// остальное — нет. Это снимает автоматику «прочитай первые два
// предложения» и даёт контроль над тем, как звучит голос.

test("markedSpoken берёт только помеченные строки", () => {
  assert.equal(TTS.markedSpoken("\uD83D\uDD08 Первая фраза.\nОбычный текст."), "Первая фраза.");
  assert.equal(TTS.markedSpoken("Обычный текст без метки."), "");
  assert.equal(TTS.markedSpoken("\uD83D\uDD08 Одна.\n\uD83D\uDD08 Две."), "Одна. Две.");
});

test("markedSpoken снимает markdown вокруг метки", () => {
  assert.equal(TTS.markedSpoken("**\uD83D\uDD08** С жирной меткой"), "С жирной меткой");
  assert.equal(TTS.markedSpoken("- \uD83D\uDD08 В списке"), "В списке");
});

test("manual: без метки — тишина", () => {
  assert.equal(TTS.pickSpoken("Обычный ответ.", "manual", 2), "");
  assert.equal(TTS.pickSpoken("\uD83D\uDD08 Скажи это.", "manual", 2), "Скажи это.");
});

test("метка важнее любого режима", () => {
  // Даже в full, где читалось бы всё, произносится только помеченное.
  assert.equal(TTS.pickSpoken("\uD83D\uDD08 Только это.\nмного текста тут", "full", 2), "Только это.");
  assert.equal(TTS.pickSpoken("\uD83D\uDD08 Только это.\nмного текста тут", "brief", 2), "Только это.");
});

test("без метки поведение прежнее: brief читает начало, full — всё", () => {
  assert.equal(TTS.pickSpoken("Раз. Два. Три. Четыре.", "brief", 2), "Раз. Два.");
  assert.equal(TTS.pickSpoken("Раз. Два. Три. Четыре.", "full", 2), "Раз. Два. Три. Четыре.");
});
