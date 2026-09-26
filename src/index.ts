// OpenCode Voice V2 — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice2
//
// Голосовое управление OpenCode.
//
// Команды (вводятся в TUI):
//   /voice                  — push-to-talk: записать микрофон, распознать, вставить текст
//   /voice <file.wav|mp3|m4a|ogg|flac> — распознать готовый аудиофайл
//   /voice backend [local|api]         — показать/переключить бэкенд распознавания
//   /voice lang [ru|en|auto]           — показать/установить язык распознавания
//   /voice device [auto|gpu|cpu]       — GPU (whisper.cpp) или CPU (faster-whisper)
//   /voice doctor [--fix]              — диагностика/ремонт кнопки и микрофона
//   /voice heal                        — ручное восстановление (рестарт сервера + аудиоканал)
//   /voice help                        — список возможностей
//
// V2 API: plain object { id, setup(ctx) } БЕЗ value-импорта @opencode/plugin
// (иначе лоадер тянет сборку node_modules и падает). Команды регистрируются
// синхронно через ctx.command.transform; тяжёлая работа — внутри async execute().
// Результат отправляется через ctx.session.prompt({ sessionID, text, delivery }).

import { $ } from "./lib/shell"
import { STT_LANGUAGES, STT_DEVICES, DEFAULTS, PLUGIN_VERSION } from "./lib/config"
import { resolveState, saveState, envOverride } from "./lib/state"
import { ensureSttServer, startServerWatchdog } from "./lib/server-launcher"

// Минимальные структурные типы V2-контекста (без импорта @opencode/plugin).
interface VoicePrompt {
  text?: string
}
interface VoiceInvocation {
  sessionID: string
  prompt?: VoicePrompt
  delivery?: "steer" | "queue" | null
}
interface VoiceSession {
  prompt: (input: {
    sessionID: string
    text: string
    delivery?: "steer" | "queue" | null
  }) => Promise<unknown>
}
interface VoiceCommandEditor {
  add(definition: {
    name: string
    description?: string
    execute: (input: VoiceInvocation) => Promise<void>
  }): void
}
interface VoiceContext {
  location: { directory: string }
  command: { transform: (fn: (editor: VoiceCommandEditor) => void) => void | Promise<void> }
  session: VoiceSession
}

export default {
  id: "voice",
  async setup(ctx: VoiceContext) {
    const directory = ctx.location.directory

    const log = (message: string, extra?: Record<string, unknown>) => {
      try {
        if (extra !== undefined) console.log(`[voice] ${message}`, JSON.stringify(extra))
        else console.log(`[voice] ${message}`)
      } catch {
        // logging is best-effort
      }
    }

    // Настройки переживают перезапуск: env > ~/.config/opencode-voice/state.json > дефолты.
    const state = resolveState({
      backend: DEFAULTS.sttBackend,
      language: DEFAULTS.sttLanguage,
      device: DEFAULTS.sttDevice,
    }) as {
      backend: "local" | "api"
      language: string
      device: string
    }

    // Авто-старт STT-сервера при загрузке плагина, чтобы Chrome-расширение сразу работало.
    void ensureSttServer(directory, log)
    const stopWatchdog = startServerWatchdog(directory, log)

    // Служебные ответы не должны превращаться в пустой запрос к модели:
    // кладём осмысленный текст с просьбой не отвечать (OpenCode всегда
    // вызывает prompt() после execute, как и в V1 после хука).
    const svc = (t: string) =>
      `(служебное сообщение плагина Voice, ответ не нужен) ${t}`

    const answer = async (invocation: VoiceInvocation, text: string) => {
      await ctx.session.prompt({
        sessionID: invocation.sessionID,
        text,
        delivery: invocation.delivery ?? undefined,
      })
    }

    // Выполнения строго последовательны: второй /voice ждёт конца первого
    // и не прерывает чужую запись.
    let tail: Promise<void> = Promise.resolve()
    const runSequential = <T>(fn: () => Promise<T>): Promise<T> => {
      const next = tail.then(fn)
      tail = next.then(
        () => undefined,
        () => undefined,
      )
      return next
    }

    const executeVoice = async (invocation: VoiceInvocation): Promise<void> => {
      await runSequential(async () => {
        // Аргументы — из prompt.text (возможен префикс /voice — срезается).
        const raw = String(invocation.prompt?.text ?? "")
          .trim()
          .replace(/^\/?voice\b/i, "")
          .trim()
        const parts = raw.split(/\s+/).filter(Boolean)
        const sub = parts[0]?.toLowerCase()

        // /voice backend [local|api]
        if (sub === "backend") {
          const want = parts[1]?.toLowerCase()
          if (!want) {
            await answer(invocation, svc(`Текущий бэкенд: ${state.backend}`))
            return
          }
          if (want !== "local" && want !== "api") {
            await answer(invocation, svc(`Неизвестный бэкенд «${want}». Доступные: local, api`))
            return
          }
          state.backend = want as "local" | "api"
          const noteB = !saveState({ backend: state.backend })
            ? " (не сохранилось)"
            : envOverride("backend")
              ? " — env OPENCODE_VOICE_BACKEND перекроет при перезапуске"
              : " (сохранено)"
          await answer(invocation, svc(`Бэкенд переключён на: ${state.backend}${noteB}`))
          return
        }

        // /voice lang [ru|en|auto]
        if (sub === "lang") {
          const want = parts[1]?.toLowerCase()
          if (!want) {
            await answer(invocation, svc(`Текущий язык: ${state.language}`))
            return
          }
          if (!(STT_LANGUAGES as readonly string[]).includes(want)) {
            await answer(
              invocation,
              svc(`Неизвестный язык «${want}». Доступные: ${STT_LANGUAGES.join(", ")}`),
            )
            return
          }
          state.language = want
          const noteL = !saveState({ language: state.language })
            ? " (не сохранилось)"
            : envOverride("language")
              ? " — env OPENCODE_VOICE_LANGUAGE перекроет при перезапуске"
              : " (сохранено)"
          await answer(invocation, svc(`Язык установлен: ${state.language}${noteL}`))
          return
        }

        // /voice device [auto|gpu|cpu] — выбор CPU/GPU для локального распознавания
        if (sub === "device" || sub === "dev") {
          const want = parts[1]?.toLowerCase()
          if (!want) {
            await answer(invocation, svc(`Текущее устройство: ${state.device} (auto: GPU, иначе CPU)`))
            return
          }
          if (!(STT_DEVICES as readonly string[]).includes(want)) {
            await answer(
              invocation,
              svc(`Неизвестное устройство «${want}». Доступные: ${STT_DEVICES.join(", ")}`),
            )
            return
          }
          state.device = want
          const noteD = !saveState({ device: state.device })
            ? " (не сохранилось)"
            : envOverride("device")
              ? " — env OPENCODE_VOICE_DEVICE перекроет при перезапуске"
              : " (сохранено)"
          await answer(invocation, svc(`Устройство установлено: ${state.device}${noteD}`))
          return
        }

        // /voice doctor [--fix] — диагностика/ремонт кнопки и микрофона
        if (sub === "doctor" || sub === "diag" || sub === "check") {
          const { doctorScript } = await import("./lib/heal")
          const script = doctorScript(directory)
          if (!script) {
            await answer(invocation, svc("doctor.sh не найден рядом с плагином"))
            return
          }
          const fix = parts.includes("--fix") || parts.includes("fix")
          try {
            const out = fix
              ? await $`bash ${script} --fix`.text()
              : await $`bash ${script}`.text()
            const tailLines = out.trim().split("\n").slice(-14).join("\n")
            await answer(
              invocation,
              svc(`диагностика (${fix ? "с ремонтом" : "только чтение"}):\n${tailLines}`),
            )
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e)
            await log("doctor failed", { error: msg })
            await answer(invocation, svc(`ошибка doctor: ${msg}`))
          }
          return
        }

        // /voice heal|fix|restart — ручное восстановление (doctor.sh --fix)
        if (sub === "heal" || sub === "fix" || sub === "restart") {
          try {
            const { heal } = await import("./lib/heal")
            const res = await heal($, { directory, force: true, reason: "manual", log })
            await answer(
              invocation,
              svc(
                res.healed
                  ? `восстановление выполнено (${res.script ? "doctor.sh --fix" : "рестарт сервера + аудиоканал"})`
                  : `восстановление не выполнено${res.skipped ? ` (${res.skipped})` : ""}`,
              ),
            )
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e)
            await log("heal failed", { error: msg })
            await answer(invocation, svc(`ошибка восстановления: ${msg}`))
          }
          return
        }

        // /voice help — список возможностей
        if (sub === "help" || sub === "-h" || sub === "--help") {
          const helpText =
            `Voice v${PLUGIN_VERSION}:\n` +
            "• /voice — запись → текст в поле ввода (авто-стоп по тишине)\n" +
            "• /voice backend [local|api]\n" +
            "• /voice lang [ru|en|auto]\n" +
            "• /voice device [auto|gpu|cpu]\n" +
            "• /voice doctor [--fix] — диагностика кнопки/микрофона\n" +
            "• /voice heal — восстановить (рестарт сервера + аудиоканал)\n" +
            "• /voice <файл.wav|mp3|m4a|ogg|flac>"
          await answer(invocation, svc(helpText))
          return
        }

        // /voice <file> — распознать готовый аудиофайл
        if (
          parts.length &&
          (parts[0].endsWith(".wav") ||
            parts[0].endsWith(".mp3") ||
            parts[0].endsWith(".m4a") ||
            parts[0].endsWith(".ogg") ||
            parts[0].endsWith(".flac"))
        ) {
          const file = parts[0]
          const resolved = file.startsWith("/") ? file : `${directory}/${file}`
          try {
            const { transcribe, stripNonSpeech } = await import("./lib/stt")
            const rawText = await transcribe({
              backend: state.backend,
              language: state.language,
              device: state.device,
              file: resolved,
              $,
              source: "command-file",
            })
            const text = stripNonSpeech(rawText)
            if (!text) {
              await answer(invocation, svc(`/voice ${file}: речь не распознана (только шум)`))
              return
            }
            await answer(invocation, text)
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e)
            await log("transcribe file failed", { error: msg })
            await answer(invocation, svc(`/voice ${file}: ошибка распознавания — ${msg}`))
          }
          return
        }

        // /voice — запись до тишины (жёсткий предел: OPENCODE_VOICE_MAX_RECORD_SECONDS)
        // -> распознавание -> текст в промпт.
        // При сбое — авто-восстановление (heal) и одна повторная попытка.
        // При окончательной ошибке бросаем исключение: иначе OpenCode отправит
        // пустой запрос модели.
        try {
          const rec = await import("./lib/recorder")
          const { transcribe, stripNonSpeech } = await import("./lib/stt")
          const { beep } = await import("./lib/beep")

          const recordOnce = async () => {
            await beep($, 880, 120)
            const s = await rec.startPushToTalk($)
            await rec.waitPushToTalkAuto(s)
            await beep($, 520, 140)
            return s
          }

          const attempt = async (): Promise<string> => {
            let session = await recordOnce()
            if (rec.pttFileSize(session.file) < 2000) {
              // Аудиоканал WSLg отвалился — один раз пересоздаём и пробуем снова.
              await log("ptt no audio, recovering", { file: session.file })
              await rec.recoverMic($)
              session = await recordOnce()
            }
            if (rec.pttFileSize(session.file) < 2000) {
              throw new Error("пустая запись (микрофон молчит)")
            }

            let rawText: string
            try {
              rawText = await transcribe({
                backend: state.backend,
                language: state.language,
                device: state.device,
                file: session.file,
                $,
                source: "command",
              })
            } catch (e: unknown) {
              const msg = e instanceof Error ? e.message : String(e)
              throw new Error(`ошибка распознавания: ${msg}`)
            }
            const text = stripNonSpeech(rawText)
            if (!text) throw new Error("речь не распознана (только шум)")
            return text
          }

          let text: string | null = null
          let lastError: Error | null = null
          for (let i = 0; i < 2 && text === null; i++) {
            try {
              text = await attempt()
            } catch (e: unknown) {
              lastError = e instanceof Error ? e : new Error(String(e))
              if (i === 0) {
                await log("ptt attempt failed", { error: lastError.message })
                const { heal } = await import("./lib/heal")
                const res = await heal($, { directory, reason: lastError.message, log })
                if (res.healed) continue
              }
            }
          }
          if (text === null) {
            await log("ptt failed", { error: lastError?.message })
            throw lastError || new Error("ptt: не удалось распознать")
          }
          await beep($, 660, 120)
          await answer(invocation, text)
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e)
          await log("ptt aborted", { error: msg })
          throw e
        }
      })
    }

    // Синхронная регистрация; вся тяжёлая работа — внутри executeVoice.
    ctx.command.transform((editor) => {
      editor.add({
        name: "voice",
        description: "Голосовой ввод: запись с микрофона → текст (backend/lang/device/doctor/heal/help, файлы)",
        execute: executeVoice,
      })
      editor.add({
        name: "v",
        description: "Алиас /voice",
        execute: executeVoice,
      })
    })

    // Cleanup останавливает вотчдог STT-сервера при выгрузке плагина.
    return () => {
      try {
        stopWatchdog()
      } catch {
        // best-effort
      }
    }
  },
}
