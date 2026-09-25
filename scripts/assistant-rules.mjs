#!/usr/bin/env node
// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
//
// Разворачивает правила озвучки для ассистента в глобальные инструкции
// OpenCode (~/.config/opencode/AGENTS.md). Оттуда они действуют во ВСЕХ
// сессиях и на любой машине после установки — это и есть «железобетонная»
// доставка: правило не живёт в памяти агента, а приходит инструкцией.
//
// Текст правил берётся из shared/tts-manifest.json (раздел assistant) —
// единственный источник истины. Ничего не дублируется в коде.
//
// Блок обрамляется маркерами и заменяется целиком, поэтому повторный запуск
// не дублирует текст. Удаление --uninstall вырезает только наш блок и
// ничего больше.
//
//   node scripts/assistant-rules.mjs print        # показать блок
//   node scripts/assistant-rules.mjs install      # установить/обновить
//   node scripts/assistant-rules.mjs check        # статус без записи
//   node scripts/assistant-rules.mjs uninstall    # вырезать блок
//   node scripts/assistant-rules.mjs install --file /tmp/AGENTS.md
//
// Флаги: --file <путь>   куда писать (по умолчанию путь из манифеста)
//        --json          машинный вывод (для тестов)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, "..")

const argv = process.argv.slice(2)
const cmd = argv.find((a) => !a.startsWith("-")) || "check"
const flag = (name, dflt) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const asJson = argv.includes("--json")

function manifest() {
  const p = resolve(REPO, "shared", "tts-manifest.json")
  return JSON.parse(readFileSync(p, "utf8"))
}

function expandHome(p) {
  return p.startsWith("~/") ? resolve(homedir(), p.slice(2)) : resolve(p)
}

/** Текст нашего блока целиком, вместе с обрамляющими маркерами. */
export function renderBlock(m) {
  const a = m.assistant
  if (!a || a.enabled === false) return null
  if (!a.rulesMarkdown || !a.beginSentinel || !a.endSentinel) {
    throw new Error("манифест: в assistant нет rulesMarkdown или маркеров блока")
  }
  return `${a.beginSentinel}\n<!-- Плагин OpenCode Voice. Не редактируйте вручную: -->\n<!-- файл обновляется при ./setup.sh --rules. Правка — shared/tts-manifest.json, раздел assistant. -->\n<!-- Удаление: ./setup.sh --uninstall-rules -->\n\n${a.rulesMarkdown.trim()}\n\n${a.endSentinel}\n`
}

/** Что сейчас лежит в файле между маркерами (null — блока нет). */
export function findBlock(text, m) {
  const { beginSentinel: b, endSentinel: e } = m.assistant
  const i = text.indexOf(b)
  if (i < 0) return null
  const j = text.indexOf(e, i)
  if (j < 0) return { raw: text.slice(i), broken: true }
  return { raw: text.slice(i, j + e.length), broken: false }
}

/** Возвращает новый текст файла и что именно изменилось. Идемпотентно. */
export function applyInstall(text, block) {
  const b = block.trimEnd()
  const m = markerOf(block)
  const cur = findBlock(text, m)
  if (cur && !cur.broken && cur.raw.trimEnd() === b) {
    return { text, changed: false, had: true, reason: "уже установлено" }
  }
  if (cur && cur.broken) {
    // Хвост без закрывающего маркера — чистим и переписываем целиком.
    return { text: text.slice(0, text.indexOf(m.assistant.beginSentinel)) + block, changed: true, had: true, reason: "блок был повреждён, перезаписан" }
  }
  if (cur) {
    const i = text.indexOf(m.assistant.beginSentinel)
    const j = text.indexOf(m.assistant.endSentinel, i) + m.assistant.endSentinel.length
    return { text: text.slice(0, i) + b + text.slice(j), changed: true, had: true, reason: "обновлён" }
  }
  const sep = text.trim() ? "\n\n" : ""
  return { text: text + sep + b, changed: true, had: false, reason: "установлен" }
}

export function applyUninstall(text, m) {
  const cur = findBlock(text, m)
  if (!cur) return { text, changed: false, had: false, reason: "блока не было" }
  const i = text.indexOf(m.assistant.beginSentinel)
  const j = cur.broken ? text.length : text.indexOf(m.assistant.endSentinel, i) + m.assistant.endSentinel.length
  const out = (text.slice(0, i) + text.slice(j)).replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "\n")
  return { text: out, changed: true, had: true, reason: "вырезан" }
}

function markerOf(block) {
  return {
    assistant: {
      beginSentinel: block.match(/<!-- OPENCODE-VOICE:BEGIN -->/)[0],
      endSentinel: block.match(/<!-- OPENCODE-VOICE:END -->/)[0],
    },
  }
}

// ---- выполнение -----------------------------------------------------------
// Запуск только из CLI: тесты импортируют функции выше, а не выполняют файл.
function main() {
const m = manifest()
const block = renderBlock(m)
const target = expandHome(flag("--file", m.assistant.targetFile))
const exists = existsSync(target)
const current = exists ? readFileSync(target, "utf8") : ""
const state = findBlock(current, m)

let result
if (cmd === "print") {
  process.stdout.write(block)
  process.exit(0)
} else if (cmd === "install") {
  if (!block) { console.error("правила отключены в манифесте (assistant.enabled = false)"); process.exit(1) }
  const r = applyInstall(current, block)
  if (r.changed) {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, r.text, "utf8")
  }
  result = { action: "install", file: target, changed: r.changed, reason: r.reason }
} else if (cmd === "uninstall") {
  const r = applyUninstall(current, m)
  if (r.changed) writeFileSync(target, r.text, "utf8")
  result = { action: "uninstall", file: target, changed: r.changed, reason: r.reason }
} else {
  result = {
    action: "check",
    file: target,
    exists,
    installed: !!state && !state.broken,
    broken: !!state && state.broken,
    version: m.version,
    marker: m.speak.marker,
    levels: m.speak.levelOrder,
  }
}

if (asJson) { console.log(JSON.stringify(result, null, 2)); process.exit(0) }
if (cmd === "check") {
  if (result.broken) console.log(`! правила повреждены в ${target} — переустановите: ./setup.sh --rules`)
  else if (result.installed) console.log(`✓ правила озвучки установлены в ${target}`)
  else console.log(`· правила озвучки не установлены (${target}) — ./setup.sh --rules`)
} else if (cmd === "install") {
  console.log(`${result.changed ? "✓" : "·"} ${result.reason}: ${result.file}`)
} else {
  console.log(`${result.changed ? "✓" : "·"} ${result.reason}: ${result.file}`)
}
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main()
