// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
/**
 * Deployment: загруженный bundle самодостаточен и не зависит от cwd.
 *
 * Именно bundle отдаётся OpenCode, поэтому проверяем его, а не src/: в bundle
 * server-launcher.ts и heal.ts лежат в <bundle>/lib/, а stt-server/, shared/ и
 * doctor.sh — на уровень выше. Запуск теста идёт из чужого каталога, чтобы
 * cwd-кандидаты не могли «спасти» резолвинг.
 *
 * До этого bundle содержал только entrypoints и lib/, поэтому сервис, запущенный
 * не из корня проекта, получал «stt server script not found» и «doctor.sh не найден».
 */
import test from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..")
const BUNDLE = path.join(ROOT, ".opencode", "plugins", "voice")
const FOREIGN = mkdtempSync(path.join(tmpdir(), "ovi-foreign-"))

const { serverScript } = await import(path.join(BUNDLE, "lib", "server-launcher.ts"))
const { doctorScript } = await import(path.join(BUNDLE, "lib", "heal.ts"))

test("bundle содержит runtime-ресурсы, без которых он не автономен", () => {
  for (const rel of [
    "index.ts",
    "tui.tsx",
    "lib/shell.ts",
    "lib/server-launcher.ts",
    "lib/heal.ts",
    "stt-server/stt_server.py",
    "shared/stt-spec.json",
    "doctor.sh",
    "fix-mic.sh",
  ]) {
    assert.ok(existsSync(path.join(BUNDLE, rel)), `в bundle нет ${rel} — запусти bash sync-plugin.sh`)
  }
})

test("stt_server.py находится относительно пакета, а не cwd", () => {
  const found = serverScript(FOREIGN)
  assert.ok(found, "launcher должен найти stt_server.py при чужом directory")
  assert.ok(
    found.startsWith(path.join(BUNDLE, "stt-server")),
    `ожидался путь внутри bundle, получено: ${found}`,
  )
  assert.ok(existsSync(found), `файл не существует: ${found}`)
})

test("doctor.sh находится относительно пакета, а не cwd", () => {
  const found = doctorScript(FOREIGN)
  assert.ok(found, "heal должен найти doctor.sh при чужом directory")
  assert.ok(
    found.startsWith(BUNDLE),
    `ожидался путь внутри bundle, получено: ${found}`,
  )
  assert.ok(existsSync(found), `файл не существует: ${found}`)
})

test("TS и Python читают один и тот же shared/stt-spec.json", () => {
  // Python: Path(stt_server.py).parents[1]/shared/stt-spec.json
  // TS в bundle: new URL("../shared/stt-spec.json", import.meta.url) из <bundle>/lib/
  const fromPython = path.resolve(BUNDLE, "stt-server", "..", "shared", "stt-spec.json")
  const fromTs = path.resolve(BUNDLE, "lib", "..", "shared", "stt-spec.json")
  assert.equal(fromPython, fromTs, "пути к спеку разошлись")
  assert.ok(existsSync(fromPython), `spec отсутствует: ${fromPython}`)
})
