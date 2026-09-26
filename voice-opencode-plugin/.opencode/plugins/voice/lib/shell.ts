// OpenCode Voice V2 — запуск процессов без shell (замена Bun shell `$`).
//
// Почему не exec/strict-shell: exec() собирает одну строку и передаёт её
// /bin/bash, поэтому любой путь из пользовательского ввода (`/voice <file>`,
// WHISPER_CPP_MODEL, WHISPER_CPP_BIN, recorder-пути) становится shell-кодом.
// Здесь команда — это argv: литеральные куски шаблона режутся токенизатором
// (это доверенный код репозитория), а подставленные значения всегда остаются
// ОДНИМ аргументом и никогда не разбираются заново. Метасимволы (`;` `|` `&&`
// `$()` `` ` ``) в значении остаются обычными символами.
//
// Контракт (совпадает с Bun `$`, который используют src/lib/* и fake-bash в тестах):
//   await $`cmd ${arg}`.text()   — stdout, reject при ненулевом exit
//   await $`cmd ${arg}`.quiet()  — ничего не возвращает, reject при ошибке
//   await $`cmd ${arg}`.code()   — код возврата (0 или 1)
//
// Шелл-билдины `command -v` / `test -x` реализованы нативно (внешних бинарников
// с такими именами нет), остальное уходит в execFile с shell:false.
import { execFile } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { delimiter, join } from "node:path"

export interface ShellResult {
  text: () => Promise<string>
  quiet: () => Promise<void>
  code: () => Promise<number>
}

const MAX_BUFFER = 4 * 1024 * 1024

/**
 * Токенизация ЛИТЕРАЛЬНОЙ части шаблона (только код репозитория).
 * Поддерживает одинарные/двойные кавычки и backslash-escape, чтобы
 * `python3 -c "import os; print('ok')"` оставалось двумя аргументами.
 */
function tokenizeLiteral(src: string): string[] {
  const out: string[] = []
  let cur = ""
  let started = false
  let quote: '"' | "'" | null = null
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quote) {
      if (ch === quote) {
        quote = null
        continue
      }
      if (ch === "\\" && quote === '"' && i + 1 < src.length) {
        cur += src[++i]
        continue
      }
      cur += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      started = true
      continue
    }
    if (ch === "\\" && i + 1 < src.length) {
      cur += src[++i]
      started = true
      continue
    }
    if (/\s/.test(ch)) {
      if (started) {
        out.push(cur)
        cur = ""
        started = false
      }
      continue
    }
    cur += ch
    started = true
  }
  if (started) out.push(cur)
  return out
}

/** Аналог `command -v`: абсолютный путь к исполняемому файлу или null. */
export function resolveBin(name: string): string | null {
  if (!name) return null
  if (name.includes("/")) {
    try {
      accessSync(name, constants.X_OK)
      return name
    } catch {
      return null
    }
  }
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // следующий каталог
    }
  }
  return null
}

type Outcome = { code: number; stdout: string; stderr: string }

function fail(message: string, code = 127): Outcome {
  const err = new Error(message) as Error & { code?: number }
  err.code = code
  return { code, stdout: "", stderr: message }
}

/** Встроенные команды shell, реализованные без /bin/bash. */
function builtin(argv: string[]): Outcome | null {
  const [cmd, ...args] = argv
  if (cmd === "command" || cmd === "which") {
    if (cmd === "which" ? args.length === 1 : args[0] === "-v" && args.length === 2) {
      const found = resolveBin(String(args[args.length - 1]))
      return found ? { code: 0, stdout: `${found}\n`, stderr: "" } : fail(`${args[args.length - 1]}: not found`)
    }
    return null
  }
  if (cmd === "test" || cmd === "[") {
    const positional = cmd === "[" ? args.filter((a) => a !== "]") : args
    if (positional.length === 2 && /^-\w$/.test(positional[0])) {
      const flag = positional[0].slice(1)
      const mode = flag === "f" ? constants.F_OK : flag === "d" ? constants.F_OK : constants.X_OK
      try {
        accessSync(positional[1], mode)
        return { code: 0, stdout: "", stderr: "" }
      } catch {
        return { code: 1, stdout: "", stderr: "" }
      }
    }
    return null
  }
  return null
}

function execute(argv: string[]): Promise<Outcome> {
  if (argv.length === 0) return Promise.resolve({ code: 0, stdout: "", stderr: "" })
  const handled = builtin(argv)
  if (handled) return Promise.resolve(handled)

  const [file, ...args] = argv
  return new Promise<Outcome>((resolve) => {
    execFile(
      file,
      args,
      { maxBuffer: MAX_BUFFER, encoding: "utf8", windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1
          const detail = String(stderr || "").trim() || err.message
          resolve({ code, stdout: String(stdout || ""), stderr: detail })
          return
        }
        resolve({ code: 0, stdout: String(stdout || ""), stderr: String(stderr || "") })
      },
    )
  })
}

export function $(strings: TemplateStringsArray, ...values: unknown[]): ShellResult {
  const argv: string[] = []
  for (let i = 0; i < strings.length; i++) {
    argv.push(...tokenizeLiteral(strings[i]))
    if (i >= values.length) continue
    const value = values[i]
    if (value === undefined || value === null) continue
    // Массив — несколько отдельных аргументов (как в Bun $); строка — ровно один.
    if (Array.isArray(value)) {
      for (const item of value) argv.push(String(item))
    } else {
      argv.push(String(value))
    }
  }

  const run = () => execute(argv)
  const rejectOnError = async (): Promise<Outcome> => {
    const result = await run()
    if (result.code !== 0) {
      throw Object.assign(new Error(result.stderr || `exit ${result.code}`), {
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
      })
    }
    return result
  }

  return {
    text: async () => (await rejectOnError()).stdout,
    quiet: async () => {
      await rejectOnError()
    },
    code: async () => (await run()).code === 0 ? 0 : 1,
  }
}

export type Shell = typeof $
