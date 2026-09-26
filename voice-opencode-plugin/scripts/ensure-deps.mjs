#!/usr/bin/env node
// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice2
/**
 * Сторож для typecheck/build.
 *
 * Зачем: раньше `npm run typecheck` при отсутствующем `tsc` печатал
 * «sh: 1: tsc: not found» и при этом НЕ падал — то есть CI оставался зелёным
 * на коде, который никто не проверял. Это самый опасный вид тихой поломки.
 *
 * Теперь скрипт без установленных зависимостей завершается с кодом 1
 * и понятным текстом, а не притворяется успехом.
 */

import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const MIN_NODE_MAJOR = 22
const MIN_NODE_MINOR = 6

function fail(lines) {
  process.stderr.write(lines.join("\n") + "\n")
  process.exit(1)
}

// 1) Версия Node: тесты используют --experimental-strip-types (Node 22.6+),
//    а typecheck/build сами по себе требуют актуального tsc.
const [major, minor] = process.versions.node.split(".").map(Number)
if (major < MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor < MIN_NODE_MINOR)) {
  fail([
    `✗ Нужен Node ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} или новее, а запущен ${process.version}.`,
    "",
    "  Тесты используют `node --experimental-strip-types` — флаг появился в 22.6.",
    "  Установить: https://nodejs.org  (или nvm install 22)",
  ])
}

// 2) Зависимости: без них tsc недоступен и проверка типов фиктивна.
let tsVersion = null
try {
  tsVersion = require("typescript/package.json").version
} catch {
  fail([
    "✗ Зависимости не установлены: typescript не найден в node_modules.",
    "",
    "  npm run typecheck / npm run build БЕЗ зависимостей ничего не проверяют,",
    "  поэтому скрипт останавливается, а не делает вид, что всё в порядке.",
    "",
    "  Что делать:",
    "    npm ci          # если есть package-lock.json",
    "    npm install     # иначе",
    "",
    `  Если node_modules лежит на /mnt/c (v9fs), установка может падать с EACCES`,
    `  на rename — тогда перенесите проект на файловую систему Linux:`,
    `    cp -r "$(pwd)" ~/projects/opencode-voice && cd ~/projects/opencode-voice && npm ci`,
  ])
}

process.stdout.write(`✓ зависимости на месте (typescript ${tsVersion}, node ${process.version})\n`)
