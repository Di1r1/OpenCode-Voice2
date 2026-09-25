// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
/**
 * Персист настроек плагина (backend / language / device).
 *
 * `/voice backend|lang|device` пишет выбор в JSON-файл, чтобы он переживал
 * перезапуск OpenCode. Приоритет при старте:
 *   env (OPENCODE_VOICE_BACKEND/LANGUAGE/DEVICE) > файл > дефолты.
 *
 * Переменные окружения:
 *   OPENCODE_VOICE_STATE_FILE   путь к файлу состояния
 *                               (по умолчанию ~/.config/opencode-voice/state.json)
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export interface VoiceState {
  backend?: string
  language?: string
  device?: string
}

const KEYS = ["backend", "language", "device"] as const

/** Путь к файлу состояния (env → ~/.config/opencode-voice/state.json). */
export function statePath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return env.OPENCODE_VOICE_STATE_FILE || join(home, ".config", "opencode-voice", "state.json")
}

/** Читает сохранённое состояние; {} при отсутствии/битом файле. */
export function loadState(file: string = statePath()): VoiceState {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"))
    if (!raw || typeof raw !== "object") return {}
    const out: VoiceState = {}
    for (const key of KEYS) {
      const value = (raw as Record<string, unknown>)[key]
      if (typeof value === "string" && value) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/** Дописывает состояние (атомарно, через .tmp) и возвращает успех. */
export function saveState(patch: VoiceState, file: string = statePath()): boolean {
  try {
    const next = { ...loadState(file), ...patch }
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8")
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/** Итоговое состояние с приоритетом env > файл > дефолты. */
export function resolveState(
  defaults: { backend: string; language: string; device: string },
  env: NodeJS.ProcessEnv = process.env,
  file: string = statePath(env),
): { backend: string; language: string; device: string } {
  const saved = loadState(file)
  return {
    backend: env.OPENCODE_VOICE_BACKEND || saved.backend || defaults.backend,
    language: env.OPENCODE_VOICE_LANGUAGE || saved.language || defaults.language,
    device: env.OPENCODE_VOICE_DEVICE || saved.device || defaults.device,
  }
}

/** Задан ли ключ переменной окружения (env перекрывает сохранённое значение). */
export function envOverride(
  key: (typeof KEYS)[number],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env[`OPENCODE_VOICE_${key.toUpperCase()}`])
}
