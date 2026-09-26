// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice2
// Тесты правил озвучки для ассистента: scripts/assistant-rules.mjs.
//
// Правила должны быть железобетонными и при этом неприкосновенными для
// остального содержимого AGENTS.md. Поэтому проверяем идемпотентность
// (повторный запуск не дублирует блок), сохранность чужих правил и
// вырезание блока при uninstall.
//
// Запуск: npm test

import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { renderBlock, applyInstall, applyUninstall, findBlock } from "../scripts/assistant-rules.mjs"

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url))
const m = JSON.parse(readFileSync(here("../shared/tts-manifest.json"), "utf8"))
const block = renderBlock(m)

const PRE = "# Мои личные правила\n\nЗдесь что-то важное про проект.\n"

test("правила объявлены в манифесте и разворачиваются в блок", () => {
  assert.ok(m.assistant, "в манифесте нет раздела assistant")
  assert.equal(m.assistant.enabled, true, "правила должны быть включены")
  assert.equal(m.assistant.mustMarkEveryReply, true,
    "главное требование — помечать каждый ответ, оно не должно выключаться")
  assert.ok(block.startsWith(m.assistant.beginSentinel), "блок должен начинаться с маркера")
  assert.ok(block.trimEnd().endsWith(m.assistant.endSentinel), "блок должен кончаться маркером")
})

test("правила требуют метку в каждом ответе и на любом уровне", () => {
  const r = m.assistant.rulesMarkdown
  assert.ok(r.includes(m.speak.marker), "в правилах должен быть указан реальный маркер из манифеста")
  assert.ok(/каждом ответе/i.test(r), "правило «в каждом ответе» обязано быть явно сказано")
  // Ключевое требование пользователя: правило действует и в manual.
  assert.ok(r.includes("manual") && /включая `manual`|в том числе `manual`/.test(r),
    "правило должно явно распространяться на режим manual")
  // Все шесть уровней разобраны — иначе агент не знает, что помечать.
  for (const id of m.speak.levelOrder) {
    assert.ok(m.assistant.levels[id], `для уровня ${id} нет указания ассистенту`)
  }
  assert.ok(Object.keys(m.assistant.levels).includes("manual"),
    "для manual должно быть отдельное указание — там без метки молчит всё")
})

test("правила учат главной ошибке: метка в середине фразы не работает", () => {
  // Именно эта ошибка стоила нескольких итераций молчания.
  const r = m.assistant.rulesMarkdown
  assert.ok(/только в начале строки|начале строки/i.test(r), "не сказано про начало строки")
  assert.ok(r.includes("середине"), "не сказано, что в середине фразы метка не работает")
})

test("установка идемпотентна: три прохода дают один блок", () => {
  let text = PRE
  for (let i = 0; i < 3; i++) {
    const r = applyInstall(text, block)
    text = r.text
  }
  assert.equal(text.split(m.assistant.beginSentinel).length - 1, 1, "блок задублировался")
  assert.equal(text.split(m.assistant.endSentinel).length - 1, 1, "закрывающий маркер задублировался")
  // Чужие правила не тронуты.
  assert.ok(text.includes("Здесь что-то важное про проект."), "чужие правила потеряны")
  assert.ok(text.startsWith("# Мои личные правила"), "порядок содержимого нарушен")
})

test("повторная установка сообщает, что менять нечего", () => {
  const first = applyInstall(PRE, block)
  assert.equal(first.changed, true, "первая установка обязана что-то записать")
  const second = applyInstall(first.text, block)
  assert.equal(second.changed, false, "вторая установка не должна трогать файл")
  assert.equal(second.text, first.text, "текст изменился при повторной установке")
})

test("правила обновляются, если манифест изменился", () => {
  const v1 = applyInstall(PRE, block)
  const changed = block.replace("в каждом ответе", "В КАЖДОМ ответе")
  const v2 = applyInstall(v1.text, changed)
  assert.equal(v2.changed, true, "изменённые правила обязаны обновляться")
  assert.ok(v2.text.includes("В КАЖДОМ ответе"), "новая редакция не попала в файл")
  assert.equal(v2.text.split(m.assistant.beginSentinel).length - 1, 1, "при обновлении блок задублировался")
})

test("повреждённый блок восстанавливается, а не размножается", () => {
  // Хвост без закрывающего маркера — ручная правка или обрыв записи.
  const broken = PRE + m.assistant.beginSentinel + "\n\n## Часть правил\n"
  const r = applyInstall(broken, block)
  assert.equal(r.changed, true, "повреждённый блок должен перезаписываться")
  assert.equal(r.text.split(m.assistant.beginSentinel).length - 1, 1, "остался обрыв блока")
  assert.ok(r.text.includes(m.assistant.endSentinel), "не появился закрывающий маркер")
  assert.ok(r.text.includes("Здесь что-то важное про проект."), "чужие правила потеряны")
})

test("uninstall вырезает только наш блок", () => {
  const installed = applyInstall(PRE, block).text
  const r = applyUninstall(installed, m)
  assert.equal(r.changed, true, "uninstall обязан что-то убрать")
  assert.ok(!r.text.includes("OPENCODE-VOICE"), "наш блок остался в файле")
  assert.ok(r.text.includes("Здесь что-то важное про проект."), "чужие правила вырезаны вместе с нашими")
  assert.equal(findBlock(r.text, m), null, "после uninstall блока быть не должно")
})

test("uninstall на чистом файле — не ошибка", () => {
  const r = applyUninstall(PRE, m)
  assert.equal(r.changed, false)
  assert.equal(r.text, PRE, "файл изменился, хотя блока в нём не было")
})

test("пустой файл — валидный вход", () => {
  const r = applyInstall("", block)
  assert.equal(r.changed, true)
  assert.equal(r.text.trim(), block.trim(), "в пустой файл блок должен лечь без лишних переводов строк")
  assert.equal(applyUninstall(r.text, m).text.trim(), "", "после uninstall файл должен опустеть")
})
