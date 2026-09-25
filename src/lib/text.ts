// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
/**
 * Текстовая пост-обработка распознавания.
 *
 * Список служебных маркеров и символы берутся из `shared/stt-spec.json` —
 * единого источника истины для TypeScript и Python (см. stt_server.py).
 * Если файл недоступен (нестандартная упаковка), используется встроенный
 * фолбэк, совпадающий со спеком.
 *
 * Модуль не имеет зависимостей (кроме node:fs), поэтому тестируется напрямую
 * через `node --experimental-strip-types`.
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const FALLBACK_KEYWORDS = [
  "музык", "music", "аплодисмент", "applause", "смех", "laugh", "тишин", "silence",
  "шум", "noise", "звук", "sound", "свист", "whistl", "кашел", "кашл", "cough",
  "вздох", "sigh", "шёпот", "шепот", "whisper", "неразборчив", "inaudible", "пауза",
  "paus", "гудок", "сигнал", "signal", "звон", "ring", "стук", "knock", "хлопок",
  "clap", "помех", "static", "инструментал", "instrumental", "мужской голос", "женский голос",
]
const FALLBACK_SYMBOLS = "♪♫♬♩♭♮#"

interface TextSpec {
  keywords: string[]
  symbols: string
}

function loadSpec(): TextSpec {
  // shared/ лежит рядом с пакетом: в bundle (lib/) это ../shared/, в src/lib/ — ../../shared/.
  for (const rel of ["../shared/stt-spec.json", "../../shared/stt-spec.json"]) {
    try {
      const url = new URL(rel, import.meta.url)
      const raw = JSON.parse(readFileSync(fileURLToPath(url), "utf8"))
      const keywords = Array.isArray(raw?.nonSpeechKeywords) && raw.nonSpeechKeywords.length
        ? raw.nonSpeechKeywords.map(String)
        : FALLBACK_KEYWORDS
      const symbols = typeof raw?.nonSpeechSymbols === "string" && raw.nonSpeechSymbols
        ? raw.nonSpeechSymbols
        : FALLBACK_SYMBOLS
      return { keywords, symbols }
    } catch {
      // пробуем следующий кандидат
    }
  }
  return { keywords: FALLBACK_KEYWORDS, symbols: FALLBACK_SYMBOLS }
}

const SPEC = loadSpec()

// Служебные пометки Whisper на музыке/шуме: [музыка], (смех), ♪, *music* и т.п.
const NON_SPEECH = new RegExp(`^(?:${SPEC.keywords.join("|")})`, "i")
const SYMBOLS_RE = new RegExp(`[${SPEC.symbols.replace(/[\\\]^]/g, "\\$&")}]+`, "g")

/** Вырезает служебные пометки ([музыка], (смех), ♪ …) из результата распознавания. */
export function stripNonSpeech(text: string): string {
  let t = text
  t = t.replace(/\[[^\]]*\]/g, " ")                        // [музыка], [Music]
  t = t.replace(/\*[^*]*\*/g, " ")                          // *music*
  t = t.replace(/\(([^)]*)\)/g, (m, inner) =>
    NON_SPEECH.test(String(inner).trim()) ? " " : m)        // (смех), но не (то есть)
  t = t.replace(SYMBOLS_RE, " ")                            // ноты
  t = t.replace(/\s{2,}/g, " ").replace(/\s+([,.!?;:])/g, "$1").trim()
  return t
}

// --- TTS: чистка markdown перед озвучкой (паритет с _clean_for_speech в stt_server.py) ---

export interface CleanForSpeechOptions {
  /** Читать код как есть вместо «…код…» (по умолчанию код не читается). */
  readCode?: boolean
}

const CODE_PLACEHOLDER = "…код…"
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g
const FENCE_RE = /```[\s\S]*?```/g
const IMAGE_RE = /!\[(?:[^\]]*)\]\([^)]*\)/g
const LINK_RE = /\[([^\]]+)\]\([^)]*\)/g
const AUTOLINK_RE = /<(?:https?:\/\/[^>\s]+)>/g
const URL_RE = /https?:\/\/[^\s)]+/g
const HEADING_RE = /^\s{0,3}#{1,6}\s+/gm
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/gm
const QUOTE_RE = /^\s{0,3}>\s?/gm
const LIST_RE = /^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm
const TABLE_SEP_RE = /^\s*\|?[:\s|-]+\|?\s*$/gm
const STRIKE_RE = /~~([^~]+)~~/g
const BOLD_RE = /\*\*([^*]+)\*\*/g
const BOLD_U_RE = /__([^_]+)__/g
const ITALIC_RE = /\*([^*]+)\*/g
const ITALIC_U_RE = /(^|[\s(])_([^_]+)_(?=[\s).,!?]|$)/g

/**
 * Готовит markdown-ответ ассистента к озвучке: убирает разметку, код-блоки,
 * ссылки и таблицы, оставляя связный текст для синтеза речи.
 *
 * Паритетные кейсы — shared/tts-cases.json (тот же файл читает pytest).
 */
export function cleanForSpeech(text: string, opts: CleanForSpeechOptions = {}): string {
  const readCode = opts.readCode === true
  let t = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n")
  t = t.replace(HTML_COMMENT_RE, " ")
  t = t.replace(FENCE_RE, (block) => {
    if (!readCode) return ` ${CODE_PLACEHOLDER} `
    return " " + block.replace(/^```[^\n]*\n?/, "").replace(/```$/, "") + " "
  })
  t = t.replace(IMAGE_RE, " ")
  t = t.replace(LINK_RE, "$1")
  t = t.replace(AUTOLINK_RE, " ")
  t = t.replace(URL_RE, " ")
  t = t.replace(HEADING_RE, "")
  t = t.replace(HR_RE, " ")
  t = t.replace(QUOTE_RE, "")
  t = t.replace(LIST_RE, "")
  t = t.replace(TABLE_SEP_RE, "")
  t = t.replace(/\|/g, " ")
  t = t.replace(STRIKE_RE, "$1")
  t = t.replace(BOLD_RE, "$1")
  t = t.replace(BOLD_U_RE, "$1")
  t = t.replace(ITALIC_RE, "$1")
  t = t.replace(ITALIC_U_RE, "$1$2")
  t = t.replace(/`/g, "")
  t = t.replace(/\s+/g, " ").trim()
  return t
}
