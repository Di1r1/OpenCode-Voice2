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

// --- манифест озвучки (shared/tts-manifest.json -> GET /manifest) -------------
// Политика приезжает с сервера, поэтому расширение обязано уважать её одинаково
// на любой машине: обязательные фразы звучат всегда, запрещённые — никогда.

const manifestFixture = {
  status: "ok",
  version: 1,
  speak: { mode: "manual", marker: "🔈", briefSentences: 2, interChunkPauseMs: 220 },
  alwaysVoicePrefixes: ["Готово", "Ошибка", "Важно"],
  neverVoicePatterns: ["```", "https://", "/mnt/"],
}

test("tts.js exposes the manifest helpers", () => {
  for (const name of ["alwaysSpoken", "applyManifest", "mLevel", "levelId", "capChars"]) {
    assert.equal(typeof TTS[name], "function", `missing ${name}`)
  }
  // loadManifest сознательно НЕ в модульном объекте: он пользуется
  // serverUrl/win/dbg, которые живут внутри start(deps), и вынесенный наружу
  // падал с ReferenceError. Отдаётся экземпляром — проверка ниже.
  assert.equal(TTS.loadManifest, undefined,
    "loadManifest не должен висеть на модуле: вне start() у него нет serverUrl")
  const src = readFileSync(here("../extension/tts.js"), "utf8")
  assert.ok(/return \{[\s\S]{0,400}?loadManifest:\s*loadManifest/.test(src),
    "start() должен отдавать loadManifest в своём return")
})

test("манифест: обязательные фразы звучат без маркера", () => {
  TTS.applyManifest(manifestFixture)
  assert.equal(TTS.alwaysSpoken("Готово: тесты зелёные"), "Готово: тесты зелёные")
  // Обычный текст без маркера и без обязательного начала — молчит.
  assert.equal(TTS.alwaysSpoken("Просто пояснение без метки"), "")
  // Метка в режиме manual по-прежнему главнее всего.
  assert.equal(TTS.pickSpoken("🔈 сказать это", "manual", 2), "сказать это")
})

test("манифест: запреты гасят даже помеченную строку", () => {
  TTS.applyManifest(manifestFixture)
  assert.equal(TTS.markedSpoken("🔈 открой https://example.com"), "")
  assert.equal(TTS.markedSpoken("🔈 файл в /mnt/c/temp/x.ts"), "")
  assert.equal(TTS.markedSpoken("🔈 блок ```code```"), "")
  // Обычная реплика метку сохраняет.
  assert.equal(TTS.markedSpoken("🔈 всё готово"), "всё готово")
  // Обязательное начало тоже гасится запретом — код вслух не читаем.
  assert.equal(TTS.alwaysSpoken("Готово: https://example.com"), "")
})

test("манифест: свой маркер вместо 🔈", () => {
  TTS.applyManifest({ ...manifestFixture, speak: { ...manifestFixture.speak, marker: ">>" } })
  assert.equal(TTS.markedSpoken(">> произнести"), "произнести")
  assert.equal(TTS.markedSpoken("🔈 старый маркер молчит"), "")
  TTS.applyManifest(manifestFixture) // вернуть дефолт для следующих тестов
})

test("манифест: applyManifest(null) возвращает к дефолтам", () => {
  TTS.applyManifest(manifestFixture)
  TTS.applyManifest(null)
  assert.equal(TTS.alwaysSpoken("Готово: всё"), "", "без манифеста обязательных правил нет")
  assert.equal(TTS.markedSpoken("🔈 всё готово"), "всё готово", "маркер по умолчанию живёт")
  // Запретов без манифеста нет: строка уходит в чистку речи как есть, снятие
  // метки не должно «съедать» начало фразы.
  assert.equal(TTS.markedSpoken("🔈 всё https://example.com"), "всё https://example.com",
    "без манифеста запретов нет — чистка текста не должна ломать речь")
})

test("манифест репозитория применим расширением без потерь", () => {
  // Реальный файл, который переезжает вместе с плагином, должен работать.
  TTS.applyManifest({ status: "ok", ...readJson("../shared/tts-manifest.json") })
  assert.ok(TTS.alwaysSpoken("Готово: всё собрано"), "реальный alwaysVoicePrefixes не сработал")
  assert.equal(TTS.markedSpoken("🔈 npm ci отработал"), "", "реальный neverVoicePatterns не сработал")
  assert.equal(TTS.markedSpoken("🔈 готово к проверке"), "готово к проверке")
  TTS.applyManifest(null)
})

// ---------------------------------------------------------------------------
// Шкала подробности озвучки (1.0.47). Уровень приезжает манифестом, поэтому
// проверяем и дефолты, и настоящий файл shared/tts-manifest.json.
// ---------------------------------------------------------------------------

test("tts.js exposes the level helpers", () => {
  for (const name of ["capChars", "mLevel", "mLevelOrder", "levelId"]) {
    assert.equal(typeof TTS[name], "function", `missing ${name}`)
  }
})

test("шкала по умолчанию: пять уровней от тихого к полному", () => {
  const order = TTS.mLevelOrder()
  // Песочница vm — другой realm, у массива чужой Array.prototype, поэтому
  // deepStrictEqual ругается на «structure but not reference-equal». Сравниваем строками.
  assert.equal(Array.from(order).join(","), "quiet,normal,more,verbose,full")
  for (const id of order) {
    const cfg = TTS.mLevel(id)
    assert.ok(cfg, `уровень ${id} не описан`)
    assert.equal(typeof cfg.sentences, "number", `у ${id} нет sentences`)
    assert.equal(typeof cfg.maxChars, "number", `у ${id} нет maxChars`)
  }
})

test("больше уровень — больше текста (монотонность)", () => {
  const text = "Раз. Два. Три. Четыре. Пять. Шесть. Семь. Восемь."
  const out = ["quiet", "normal", "more", "verbose", "full"].map((id) => TTS.pickSpoken(text, id))
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].length >= out[i - 1].length,
      `уровень ${i} прочитал меньше предыдущего: "${out[i]}" против "${out[i - 1]}"`)
  }
  assert.equal(out[0], "Раз.")
  assert.equal(out[1], "Раз. Два.")
  assert.equal(out[2], "Раз. Два. Три. Четыре.")
  assert.equal(out[4], text, "full читает всё целиком")
})

test("потолок символов режет по границе предложения, а не по середине слова", () => {
  assert.equal(TTS.capChars("Короткий текст.", 100), "Короткий текст.")
  assert.equal(TTS.capChars("Ноль означает без ограничения.", 0), "Ноль означает без ограничения.")
  // Первое предложение длиннее потолка — обрыв по слову плюс многоточие.
  const long = "Очень длинное предложение которое не помещается в потолок совсем."
  const cut = TTS.capChars(long, 30)
  assert.ok(cut.length <= 31, `потолок превышен: ${cut.length}`)
  assert.ok(cut.endsWith("…"), "обрыв должен быть помечен многоточием")
  assert.equal(cut.trim().replace(/…$/, ""), long.slice(0, 30).replace(/\s+\S*$/, ""))
  // Несколько предложений — режем по границе.
  const many = "Раз. Два. Три. Четыре."
  assert.equal(TTS.capChars(many, 12), "Раз. Два.", "лишние предложения отброшены целиком")
})

test("уровень уважает потолок maxChars", () => {
  // Каждое предложение ~40 символов, 10 предложений — потолок должен сработать.
  const one = "Это предложение занимает примерно сорок символов текста."
  const text = Array(10).fill(one).join(" ")
  for (const id of ["quiet", "normal", "more", "verbose"]) {
    const cfg = TTS.mLevel(id)
    if (!(cfg.maxChars > 0)) continue
    const out = TTS.pickSpoken(text, id)
    assert.ok(out.length <= cfg.maxChars, `${id}: ${out.length} > потолка ${cfg.maxChars}`)
  }
})

test("сохранённый старый режим brief мигрирует в normal", () => {
  assert.equal(TTS.levelId("brief"), "normal", "brief должен стать normal")
  assert.equal(TTS.levelId("nonsense"), "normal", "неизвестный режим падает в normal")
  assert.equal(TTS.levelId("verbose"), "verbose", "новый уровень не трогаем")
})

test("manual — не уровень: без метки молчит, с меткой говорит", () => {
  for (const id of ["quiet", "normal", "more", "verbose", "full"]) {
    assert.equal(TTS.pickSpoken("Раз. Два. Три.", "manual"), "", "manual обязан молчать без метки")
    assert.equal(TTS.pickSpoken("🔈 Раз. Два. Три.", "manual"), "Раз. Два. Три.",
      `manual с меткой обязан говорить на любом уровне (${id})`)
  }
})

test("метка важнее любого уровня, включая full", () => {
  assert.equal(TTS.pickSpoken("🔈 только это", "full"), "только это")
})

test("реальный манифест задаёт шкалу целиком", () => {
  TTS.applyManifest({ status: "ok", ...readJson("../shared/tts-manifest.json") })
  const order = TTS.mLevelOrder()
  assert.ok(order.length >= 3, `в манифесте должно быть не меньше трёх уровней, а не ${order.length}`)
  for (const id of order) {
    const cfg = TTS.mLevel(id)
    assert.ok(cfg, `уровень ${id} есть в levelOrder, но не описан в levels`)
    assert.equal(typeof cfg.label, "string", `у ${id} нет подписи — она нужна для popup`)
  }
  // Подписи едут из манифеста — на другой машине шкала подхватится сама.
  assert.ok(order.every((id) => TTS.mLevel(id).label.length > 0), "подписи уровней пустые")
  TTS.applyManifest(null)
})

test("метка в середине фразы — не метка (1.0.47)", () => {
  // Обычное упоминание символа вслух не зачитывается и не вырезается.
  const prose = "Приоритет такой: метка 🔈 важнее уровня."
  assert.equal(TTS.markedSpoken(prose), "", "упоминание метки в прозе не должно попадать в речь")
  // И настоящая метка в начале строки по-прежнему работает.
  assert.equal(TTS.markedSpoken("🔈 это надо услышать"), "это надо услышать")
  // В том числе после markdown-разметки списка.
  assert.equal(TTS.markedSpoken("- 🔈 пункт списка"), "пункт списка")
  assert.equal(TTS.markedSpoken("  > 🔈 цитата"), "цитата")
  assert.equal(TTS.markedSpoken("## 🔈 заголовок"), "заголовок")
  // Пометка не должна перебивать обязательные фразы, если она в прозе.
  TTS.applyManifest({ status: "ok", ...readJson("../shared/tts-manifest.json") })
  assert.equal(TTS.pickSpoken(`Готово: всё собрано.\nМетка 🔈 упоминается в тексте.`, "quiet"),
    "Готово: всё собрано.", "прозаическая метка не должна вытеснять обязательную фразу")
  TTS.applyManifest(null)
})

test("внешняя область не трогает внутренности start() (1.0.49)", () => {
  // Именно так был найден корневой баг: loadManifest стоял СНАРУЖИ start(deps),
  // где нет serverUrl, win и dbg. В нестрогом режиме чтение необъявленного
  // имени бросает ReferenceError синхронно, до fetch, — исключение уходило из
  // колбэка loadSettings, startTicking() не вызывался, обработчик
  // ocv-tts-status не регистрировался. Итог: «статус недоступен» без причины,
  // озвучка мертва, а content.js продолжал работать и маскировал поломку.
  const src = readFileSync(here("../extension/tts.js"), "utf8")
  const cut = src.indexOf("function start(deps)")
  assert.ok(cut > 0, "не найдена граница start()")
  const outer = src.slice(0, cut).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  for (const name of ["serverUrl", "win\\.", "\\bdbg\\(", "logTail", "\\bspeaking\\b", "gateOk", "stats\\."]) {
    const hits = outer.match(new RegExp(name, "g")) || []
    assert.equal(hits.length, 0,
      `внешняя область ссылается на внутренность start(): ${name} (${hits.length})`)
  }
})

test("loadManifest объявлен внутри start() и отдаётся наружу (1.0.49)", () => {
  // Если он снова выедет наружу, тест выше упадёт. Здесь проверяем, что
  // вызывающий код достаёт его у экземпляра, а не у модуля.
  const src = readFileSync(here("../extension/tts.js"), "utf8")
  const decl = src.indexOf("function loadManifest(cb)")
  const startAt = src.indexOf("function start(deps)")
  assert.ok(decl > startAt, "loadManifest должен быть объявлен внутри start(deps)")
  assert.ok(src.slice(startAt).includes("loadManifest: loadManifest"),
    "start() должен отдавать loadManifest наружу — иначе его нечем заменить")
})

// ---------------------------------------------------------------------------
// Журнал озвучки и версия (1.0.50)
// ---------------------------------------------------------------------------

test("версия расширения в одном месте", () => {
  // Раньше версия жила в manifest.json И строкой в content.js. Строка
  // расходилась с манифестом, и по логу нельзя было понять, что запущено.
  const man = readJson("../extension/manifest.json").version
  const tts = readFileSync(here("../extension/tts.js"), "utf8")
  const m = tts.match(/var TTS_VERSION = "([^"]+)"/)
  assert.ok(m, "в tts.js нет TTS_VERSION — версия потеряла единый источник")
  assert.equal(m[1], man, `расхождение версий: manifest=${man}, tts.js=${m[1]}`)
  assert.ok(tts.includes("TTS_VERSION: TTS_VERSION"), "tts.js должен отдавать версию наружу")
  const content = readFileSync(here("../extension/content.js"), "utf8")
  assert.ok(!/content\.js v\d+\.\d+\.\d+ loaded/.test(content),
    "content.js не должен хардкодить версию строкой — он берёт её из tts.js")
})

test("каждое решение пишется в журнал (REPORTER)", () => {
  // Пользователь просил лог «ставится метка / уходит голосом». Значит каждая
  // ветка выбора обязана оставить запись, иначе молчание нечем объяснить.
  const tts = readFileSync(here("../extension/tts.js"), "utf8")
  for (const kind of ["mark", "always", "level", "skip"]) {
    assert.ok(tts.includes(`REPORTER("${kind}"`),
      `ветка ${kind} не пишет в журнал — молчание будет нечем объяснить`)
  }
  assert.ok(tts.includes('logEvent("speak"'), "в синтез должен уходить явный лог")
  assert.ok(tts.includes("REPORTER = logEvent"), "start() обязан подменить крючок журнала")
  assert.ok(tts.includes("eventsLog:"), "журнал должен отдаваться в popup")
})

test("журнал не течёт: кольцевой буфер ограничен", () => {
  const tts = readFileSync(here("../extension/tts.js"), "utf8")
  assert.ok(/var LOG_MAX = \d+/.test(tts), "нет предела размера журнала")
  assert.ok(tts.includes("logEvents.shift()"), "буфер журнала не усекается — вырастет без предела")
})
