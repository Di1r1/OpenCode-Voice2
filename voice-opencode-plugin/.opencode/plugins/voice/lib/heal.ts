// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice2
/**
 * Авто-восстановление при сбоях.
 *
 * Запускает `doctor.sh --fix` (сервер + зависшая запись + аудиоканал), если он
 * рядом с плагином; иначе — аварийный фолбэк: убить сервер (watchdog поднимет)
 * и пересоздать аудиоканал WSLg.
 *
 * Переменные окружения:
 *   OPENCODE_VOICE_AUTO_HEAL            1|0  авто-восстановление (по умолчанию 1)
 *   OPENCODE_VOICE_AUTO_HEAL_COOLDOWN   сек  пауза между авто-восстановлениями (по умолчанию 90)
 */

import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { ensureSttServer } from "./server-launcher.ts"

export interface HealOptions {
  /** Каталог проекта OpenCode (для поиска doctor.sh). */
  directory: string
  /** Причина/повод (для лога). */
  reason?: string
  /** Игнорировать флаг авто-восстановления и кулдаун (ручной запуск). */
  force?: boolean
  log?: (message: string, extra?: Record<string, unknown>) => void | Promise<void>
  env?: NodeJS.ProcessEnv
  now?: () => number
}

export interface HealResult {
  healed: boolean
  /** Путь к doctor.sh, если найден. */
  script: string | null
  /** Причина отказа, если не выполняли. */
  skipped?: "disabled" | "cooldown" | "doctor-failed"
}

let lastHealAt = 0

/** Путь к doctor.sh: сначала относительно пакета, затем рядом с проектом. */
export function doctorScript(directory: string): string | null {
  let here = ""
  try {
    here = path.dirname(fileURLToPath(import.meta.url))
  } catch {
    here = ""
  }
  const candidates = [
    // В bundle heal.ts лежит в <bundle>/lib/, doctor.sh — в <bundle>/ (../).
    // Кандидата «на два уровня выше» намеренно нет: в раскладке исходников это
    // корень репозитория, и он перебил бы doctor.sh из переданного directory.
    here ? path.join(here, "..", "doctor.sh") : "",
    path.join(directory, "voice-opencode-plugin", "doctor.sh"),
    path.join(directory, "doctor.sh"),
    path.join(directory, ".opencode", "plugins", "doctor.sh"),
    path.join(directory, ".opencode", "plugins", "voice", "doctor.sh"),
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p)) || null
}

function autoEnabled(env: NodeJS.ProcessEnv): boolean {
  return !["0", "false", "no", "off"].includes(String(env.OPENCODE_VOICE_AUTO_HEAL ?? "1").toLowerCase())
}

function cooldownMs(env: NodeJS.ProcessEnv): number {
  const n = Number(env.OPENCODE_VOICE_AUTO_HEAL_COOLDOWN ?? "90")
  return Number.isFinite(n) && n >= 0 ? n * 1000 : 90_000
}

/** Сбрасывает кулдаун (нужно тестам и ручному запуску). */
export function resetHealCooldown(): void {
  lastHealAt = 0
}

/**
 * Пытается восстановить работоспособность. Возвращает `healed=false`, если
 * авто-восстановление выключено или сработал кулдаун (тогда повтора не будет).
 */
export async function heal($: any, opts: HealOptions): Promise<HealResult> {
  const env = opts.env || process.env
  const now = opts.now ? opts.now() : Date.now()

  if (!opts.force) {
    if (!autoEnabled(env)) return { healed: false, script: null, skipped: "disabled" }
    if (now - lastHealAt < cooldownMs(env)) return { healed: false, script: null, skipped: "cooldown" }
  }

  const script = doctorScript(opts.directory)
  if (script) {
    try {
      await $`bash ${script} --fix`.quiet()
      lastHealAt = now
      // doctor мог остановить сервер — поднимаем сразу, не дожидаясь watchdog.
      try { await ensureSttServer(opts.directory, opts.log) } catch {}
      return { healed: true, script }
    } catch (e: any) {
      lastHealAt = now
      await opts.log?.("heal: doctor failed", { script, error: e?.message || String(e) })
      return { healed: false, script, skipped: "doctor-failed" }
    }
  }

  // Фолбэк без doctor.sh: сервер убьём и сразу поднимем, аудиоканал пересоздадим.
  try { await $`pkill -f stt_server.py`.quiet() } catch {}
  try { await ensureSttServer(opts.directory, opts.log) } catch {}
  try {
    const rec = await import("./recorder.ts")
    await rec.recoverMic($)
  } catch {}
  lastHealAt = now
  return { healed: true, script: null }
}
