// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
/**
 * Конфигурация плагина.
 *
 * Переменные окружения:
 *   OPENCODE_VOICE_BACKEND   local | api     (по умолчанию local)
 *   OPENCODE_VOICE_LANGUAGE  ru | en | auto (по умолчанию ru)
 *   OPENCODE_VOICE_DEVICE    auto | gpu | cpu (по умолчанию auto: GPU, иначе CPU)
 *   OPENAI_API_KEY           ключ для облачного Whisper
 *   OPENCODE_VOICE_MODEL     модель Whisper (по умолчанию whisper-1)
 */

export const STT_LANGUAGES = ["ru", "en", "auto"] as const
export const STT_DEVICES = ["auto", "gpu", "cpu"] as const

/** Версия плагина (держим в одном месте: /voice help, логи). */
export const PLUGIN_VERSION = "0.5.0"

export const DEFAULTS = {
  sttBackend: "local" as const,
  sttLanguage: "ru" as const,
  sttDevice: "auto" as const,
  whisperModel: "whisper-1",
}

export const config = {
  whisperModel: process.env.OPENCODE_VOICE_MODEL || DEFAULTS.whisperModel,
  openaiApiKey: process.env.OPENAI_API_KEY || "",
}
