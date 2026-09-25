// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
/**
 * Реальный src/lib/shell.ts (не fake-bash): значения не должны попадать в shell.
 *
 * Проверяем, что подставленное значение остаётся ОДНИМ аргументом даже с
 * `;`, `|`, `&&`, `$()`, backtick и переводом строки — то есть старая реализация
 * через exec("/bin/bash") была бы уязвима, а текущая (execFile, shell:false)
 * трактует их как обычные символы.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { $, resolveBin } from "../src/lib/shell.ts"

const TMP = mkdtempSync(path.join(tmpdir(), "ovi-shell-"))
const NODE = process.execPath

test("интерполированное значение с метасимволами остаётся одним аргументом", async () => {
  const payload = "; touch ${PWNED} && id | tee ${PWD} `uname` \n $(whoami)"
  const out = await $`${NODE} -e ${"process.stdout.write(process.argv[1])"} ${payload}`.text()
  assert.equal(out, payload, "значение должно прийти в argv[1] без разбора")
})

test("значение с пробелами не разбивается на аргументы", async () => {
  const value = "файл с пробелами и ; точкой с запятой.wav"
  const out = await $`${NODE} -e ${"process.stdout.write(String(process.argv.length))"} ${value}`.text()
  assert.equal(out, "2", "ожидались только 2 аргумента после -e")
})

test("инъекция команды не создаёт файл (marker не создан)", async () => {
  const marker = path.join(TMP, "pwned.txt")
  // Классическая инъекция: значение само вызывает touch.
  await $`${NODE} -e ${"void 0"} ${`; touch ${marker}; #`}`.quiet()
  assert.equal(existsSync(marker), false, "инъекция не должна была выполниться")
})

test("инъекция через model path не создаёт файл", async () => {
  const marker = path.join(TMP, "pwned-model.txt")
  const evil = `/tmp/model-${`$(touch ${marker})`}.bin`
  await $`${NODE} -e ${"void 0"} ${evil}`.quiet()
  assert.equal(existsSync(marker), false, "подстановка в путь модели не должна выполняться")
})

test("массив раскрывается в несколько аргументов", async () => {
  // `--` нужен, иначе сам node пытается распарсить -mc как свой флаг.
  const out = await $`${NODE} -e ${"process.stdout.write(process.argv.slice(1).join('|'))"} -- ${["-mc", "0", "-sns"]}`.text()
  assert.equal(out, "-mc|0|-sns", "whisper.cpp-флаги должны стать отдельными argv")
})

test("кавычки в литеральной части сохраняют один аргумент", async () => {
  // python3 -c "код" — код остаётся одним аргументом (нужен -e совместимый вид).
  const out = await $`${NODE} -e ${"process.stdout.write(process.argv[1])"} "два слова"`.text()
  assert.equal(out, "два слова")
})

test("несуществующая команда отклоняется, а не выполняет строку", async () => {
  await assert.rejects(() => $`ovi-definitely-not-a-binary ${"; true"}`.text())
})

test("code() возвращает 0 для успеха и 1 для ошибки", async () => {
  assert.equal(await $`${NODE} -e ${"void 0"}`.code(), 0)
  assert.equal(await $`ovi-definitely-not-a-binary`.code(), 1)
})

test("resolveBin находит бинарь в PATH и возвращает null для неизвестного", () => {
  assert.ok(resolveBin("node"), "node есть в PATH")
  assert.equal(resolveBin("ovi-definitely-not-a-binary"), null)
  assert.equal(resolveBin(""), null)
})

test("встроенная команда command -v работает без /bin/bash", async () => {
  const out = await $`command -v ${NODE}`.text()
  assert.equal(out.trim(), NODE)
  await assert.rejects(() => $`command -v ${"ovi-definitely-not-a-binary"}`.text())
})

test("встроенная команда test -x проверяет бинарники", async () => {
  assert.equal(await $`test -x ${"/bin/sh"}`.code(), 0)
  assert.equal(await $`test -x ${"/bin/ovi-nope"}`.code(), 1)
})

test("вывод команды возвращается как есть", async () => {
  const file = path.join(TMP, "payload.txt")
  writeFileSync(file, "привет")
  assert.equal((await $`cat ${file}`.text()).trim(), "привет")
  assert.equal(readFileSync(file, "utf8"), "привет", "файл не должен изменяться командой")
})

test("exit code пробросится в text() как ошибка", async () => {
  await assert.rejects(() => $`${NODE} -e ${"process.exit(3)"}`.text(), /exit|3/)
})
