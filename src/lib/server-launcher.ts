// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
/**
 * Авто-запуск STT-сервера (stt_server.py) при загрузке плагина OpenCode.
 *
 * Переменные окружения:
 *   OPENCODE_VOICE_SERVER           1|0    авто-запуск (по умолчанию 1)
 *   OPENCODE_VOICE_SERVER_SCRIPT    путь к stt_server.py (если нестандартный)
 *   OPENCODE_VOICE_PORT             порт сервера (по умолчанию 8765)
 *   OPENCODE_VOICE_SERVER_LOG       файл лога сервера (по умолчанию /tmp/opencode/stt_server.log)
 *   OPENCODE_VOICE_SERVER_WATCHDOG_MS  период проверки живости, 0 = выкл (по умолчанию 120000)
 */

import { spawn } from "node:child_process"
import { closeSync, existsSync, openSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_PORT = 8765
const DEFAULT_WATCHDOG_MS = 120_000
const DEFAULT_LOG = "/tmp/opencode/stt_server.log"

type LogFn = (message: string, extra?: Record<string, unknown>) => void | Promise<void>

let starting = false

export function serverPort(): number {
  return Number(process.env.OPENCODE_VOICE_PORT) || DEFAULT_PORT
}

export function serverUrl(): string {
  const host = process.env.OPENCODE_VOICE_HOST || "127.0.0.1"
  return `http://${host}:${serverPort()}`
}

function isDisabled(): boolean {
  return ["0", "false", "no", "off"].includes(
    String(process.env.OPENCODE_VOICE_SERVER ?? "1").toLowerCase(),
  )
}

/** Ищет stt_server.py рядом с пакетом (экспортируется для тестов). */
export function serverScript(directory: string): string | null {
  const candidates = [
    process.env.OPENCODE_VOICE_SERVER_SCRIPT || "",
    // Относительно пакета. В загруженном bundle server-launcher.ts лежит в
    // <bundle>/lib/, а stt-server/ — в <bundle>/stt-server/ (../). В исходниках
    // src/lib/ — на уровень выше (../../). Нужны оба: сервис OpenCode стартует
    // не из корня проекта, поэтому cwd-кандидаты ненадёжны.
    fileURLToPath(new URL("../stt-server/stt_server.py", import.meta.url)),
    fileURLToPath(new URL("../../stt-server/stt_server.py", import.meta.url)),
    join(directory, "voice-opencode-plugin", "stt-server", "stt_server.py"),
    join(directory, "stt-server", "stt_server.py"),
    join(process.cwd(), "voice-opencode-plugin", "stt-server", "stt_server.py"),
    join(process.cwd(), "stt-server", "stt_server.py"),
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export async function isServerUp(timeoutMs = 1500): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(`${serverUrl()}/health`, { signal: controller.signal })
    clearTimeout(timer)
    return res.ok
  } catch {
    return false
  }
}

/** Поднимает сервер, если он не отвечает. Возвращает true, если сервер доступен. */
export async function ensureSttServer(directory: string, log?: LogFn): Promise<boolean> {
  if (isDisabled()) return false
  if (await isServerUp()) return true
  if (starting) return false
  starting = true
  try {
    const script = serverScript(directory)
    if (!script) {
      await log?.("stt server script not found", { directory })
      return false
    }
    const env: NodeJS.ProcessEnv = { ...process.env }
    // TTS читает OPENCODE_VOICE_TTS один раз при старте (stt_server.py),
    // а вотчдог/heal его не включают. Чтобы серверная озвучка работала
    // всегда после перезапуска OpenCode, поднимаем флаг, если он не задан явно.
    if (!("OPENCODE_VOICE_TTS" in env)) {
      env.OPENCODE_VOICE_TTS = "1"
    }
    if (!env.PULSE_SERVER && existsSync("/mnt/wslg/PulseServer")) {
      env.PULSE_SERVER = "unix:/mnt/wslg/PulseServer"
    }
    const args = ["-u", script, "--port", String(serverPort())]
    if (process.env.WHISPER_MODEL) args.push("--model", process.env.WHISPER_MODEL)
    // Лог сервера в файл (иначе /dev/null и диагностика распознавания слепая).
    const logPath = process.env.OPENCODE_VOICE_SERVER_LOG || DEFAULT_LOG
    let logFd: number | undefined
    try {
      logFd = openSync(logPath, "a")
    } catch {
      logFd = undefined
    }
    const child = spawn("python3", args, {
      detached: true,
      stdio: logFd !== undefined ? ["ignore", logFd, logFd] : "ignore",
      env,
    })
    child.unref()
    if (logFd !== undefined) {
      try {
        closeSync(logFd)
      } catch {
        // fd уже продублирован ребёнком
      }
    }
    await log?.("stt server starting", { script, port: serverPort(), pid: child.pid, log: logPath })
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      if (await isServerUp()) {
        await log?.("stt server ready", { port: serverPort() })
        return true
      }
    }
    await log?.("stt server did not become ready")
    return false
  } finally {
    starting = false
  }
}

/** Периодически проверяет живость сервера и перезапускает его при падении.
 * Возвращает функцию остановки вотчдога (для cleanup плагина V2). */
export function startServerWatchdog(directory: string, log?: LogFn): () => void {
  const interval = Number(process.env.OPENCODE_VOICE_SERVER_WATCHDOG_MS ?? DEFAULT_WATCHDOG_MS)
  if (!(interval > 0)) return () => {}
  const timer = setInterval(() => {
    void ensureSttServer(directory, log)
  }, interval)
  timer.unref?.()
  return () => clearInterval(timer)
}
