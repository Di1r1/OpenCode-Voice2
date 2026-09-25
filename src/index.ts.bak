// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
import type { Plugin, Hooks } from "@opencode-ai/plugin"

// NOTE: config and constants are imported dynamically inside the plugin function.
// OpenCode's legacy plugin loader (getLegacyPlugins) iterates over a module's exports
// and throws "Plugin export is not a function" for any non-function export, so we
// must avoid top-level imports of plain objects/arrays here.

/**
 * opencode-voice — голосовое управление opencode.
 *
 * Команды (вводятся в TUI):
 *   /voice            — push-to-talk: записать микрофон, распознать, вставить текст в prompt
 *   /voice <file.wav> — распознать готовый аудиофайл и вставить текст в prompt
 *   /voice backend    — показать текущий бэкенд распознавания
 *   /voice backend <local|api> — переключить бэкенд
 *   /voice lang <ru|en|auto> — установить язык распознавания
 *   /voice device <auto|gpu|cpu> — GPU (whisper.cpp) или CPU (faster-whisper)
 *
 * Текст подставляется в поле ввода opencode через client.tui.appendPrompt,
 * как будто его напечатали вручную.
 */
export const VoicePlugin: Plugin = async ({ client, $, directory }) => {
  const { STT_LANGUAGES, STT_DEVICES, DEFAULTS, PLUGIN_VERSION } = await import("./lib/config")
  // Настройки переживают перезапуск: env > ~/.config/opencode-voice/state.json > дефолты.
  const { resolveState, saveState, envOverride } = await import("./lib/state")
  const state = resolveState({
    backend: DEFAULTS.sttBackend,
    language: DEFAULTS.sttLanguage,
    device: DEFAULTS.sttDevice,
  }) as {
    backend: "local" | "api"
    language: string
    device: string
  }

  const log = async (message: string, extra?: Record<string, unknown>) => {
    try {
      await client.app.log({ body: { service: "voice", level: "info", message, extra } })
    } catch {
      // logging is best-effort
    }
  }

  // Авто-старт STT-сервера при загрузке плагина, чтобы Chrome-расширение сразу работало.
  const { ensureSttServer, startServerWatchdog } = await import("./lib/server-launcher")
  void ensureSttServer(directory, log)
  startServerWatchdog(directory, log)

  const append = (text: string) => {
    if (!text) return
    try {
      client.tui.appendPrompt({ body: { text } })
    } catch {
      // appendPrompt is best-effort
    }
  }

  const showToast = (message: string, variant: "success" | "error" | "info" = "info") => {
    try {
      client.tui.showToast({ body: { message, variant } })
    } catch {
      // Toast is best-effort
    }
  }

  const hooks: Hooks = {
    "command.execute.before": async (input, output) => {
      const cmd = input.command
      if (cmd !== "voice" && cmd !== "v") return

      // Suppress the markdown command template ($ARGUMENTS) so the LLM is not
      // invoked with the raw template for /voice subcommands — we handle them
      // entirely in the plugin. OpenCode always calls the prompt function after
      // this hook, so parts are never left empty: success paths carry the
      // transcript, info subcommands carry a service text (svc), and failures
      // throw so no request is sent at all.
      const setParts = (text: string) => {
        output.parts.length = 0
        // Part требует id/sessionID/messageID по типам, рантайм их проставляет сам.
        output.parts.push({ type: "text", text } as any)
      }
      // Служебные ответы не должны превращаться в пустой запрос к модели:
      // кладём осмысленный текст с просьбой не отвечать (OpenCode всегда
      // вызывает prompt() после хука).
      const svc = (t: string) =>
        `(служебное сообщение плагина Voice, ответ не нужен) ${t}`
      setParts("\n")
      await log("parts replaced", { now: output.parts.length })

      const args = (input.arguments || "").trim()
      const parts = args.split(/\s+/).filter(Boolean)
      const sub = parts[0]?.toLowerCase()

      // /voice backend [local|api]
      if (sub === "backend") {
        const want = parts[1]?.toLowerCase()
        if (!want) {
          showToast(`Текущий бэкенд: ${state.backend}`)
          setParts(svc(`Текущий бэкенд: ${state.backend}`))
          return
        }
        if (want !== "local" && want !== "api") {
          showToast("Доступные бэкенды: local, api", "error")
          setParts(svc(`Неизвестный бэкенд «${want}». Доступные: local, api`))
          return
        }
        state.backend = want as "local" | "api"
        const noteB = !saveState({ backend: state.backend })
          ? " (не сохранилось)"
          : envOverride("backend")
            ? " — env OPENCODE_VOICE_BACKEND перекроет при перезапуске"
            : " (сохранено)"
        showToast(`Бэкенд: ${state.backend}${noteB}`)
        setParts(svc(`Бэкенд переключён на: ${state.backend}${noteB}`))
        return
      }

      // /voice lang [ru|en]
      if (sub === "lang") {
        const want = parts[1]?.toLowerCase()
        if (!want) {
          showToast(`Текущий язык: ${state.language}`)
          setParts(svc(`Текущий язык: ${state.language}`))
          return
        }
        if (!(STT_LANGUAGES as readonly string[]).includes(want)) {
          showToast(`Доступные языки: ${STT_LANGUAGES.join(", ")}`, "error")
          setParts(svc(`Неизвестный язык «${want}». Доступные: ${STT_LANGUAGES.join(", ")}`))
          return
        }
        state.language = want
        const noteL = !saveState({ language: state.language })
          ? " (не сохранилось)"
          : envOverride("language")
            ? " — env OPENCODE_VOICE_LANGUAGE перекроет при перезапуске"
            : " (сохранено)"
        showToast(`Язык установлен: ${state.language}${noteL}`)
        setParts(svc(`Язык установлен: ${state.language}${noteL}`))
        return
      }

      // /voice device [auto|gpu|cpu] — выбор CPU/GPU для локального распознавания
      if (sub === "device" || sub === "dev") {
        const want = parts[1]?.toLowerCase()
        if (!want) {
          showToast(`Текущее устройство: ${state.device} (auto: GPU, иначе CPU)`)
          setParts(svc(`Текущее устройство: ${state.device} (auto: GPU, иначе CPU)`))
          return
        }
        if (!(STT_DEVICES as readonly string[]).includes(want)) {
          showToast(`Доступные устройства: ${STT_DEVICES.join(", ")}`, "error")
          setParts(svc(`Неизвестное устройство «${want}». Доступные: ${STT_DEVICES.join(", ")}`))
          return
        }
        state.device = want
        const noteD = !saveState({ device: state.device })
          ? " (не сохранилось)"
          : envOverride("device")
            ? " — env OPENCODE_VOICE_DEVICE перекроет при перезапуске"
            : " (сохранено)"
        showToast(`Устройство: ${state.device}${want === "cpu" ? " (faster-whisper)" : ""}${noteD}`)
        setParts(svc(`Устройство установлено: ${state.device}${noteD}`))
        return
      }

      // /voice doctor [--fix] — диагностика/ремонт кнопки и микрофона
      if (sub === "doctor" || sub === "diag" || sub === "check") {
        const fs = await import("node:fs")
        const path = await import("node:path")
        const candidates = [
          // Относительно самого пакета (работает и при установке из npm).
          path.join(path.dirname((await import("node:url")).fileURLToPath(import.meta.url)), "..", "doctor.sh"),
          path.join(directory, "voice-opencode-plugin", "doctor.sh"),
          path.join(directory, "doctor.sh"),
          path.join(directory, ".opencode", "plugins", "doctor.sh"),
        ]
        const script = candidates.find((p) => fs.existsSync(p))
        if (!script) {
          showToast("doctor.sh не найден", "error")
          setParts(svc("doctor.sh не найден рядом с плагином"))
          return
        }
        const fix = parts.includes("--fix") || parts.includes("fix")
        showToast("🩺 Проверяю…")
        try {
          const out = fix
            ? await $`bash ${script} --fix`.text()
            : await $`bash ${script}`.text()
          const tail = out.trim().split("\n").slice(-14).join("\n")
          await log("doctor", { fix })
          setParts(svc(`диагностика (${fix ? "с ремонтом" : "только чтение"}):\n${tail}`))
          showToast("🩺 Готово — смотри поле ввода", "success")
        } catch (e: any) {
          await log("doctor failed", { error: e?.message || String(e) })
          setParts(svc(`ошибка doctor: ${e?.message || e}`))
          showToast(`Ошибка doctor: ${e?.message || e}`, "error")
        }
        return
      }

      // /voice heal|fix|restart — ручное восстановление (doctor.sh --fix)
      if (sub === "heal" || sub === "fix" || sub === "restart") {
        showToast("🔧 Восстанавливаю…")
        try {
          const { heal } = await import("./lib/heal")
          const res = await heal($, { directory, force: true, reason: "manual", log })
          setParts(svc(res.healed
            ? `восстановление выполнено (${res.script ? "doctor.sh --fix" : "рестарт сервера + аудиоканал"})`
            : `восстановление не выполнено${res.skipped ? ` (${res.skipped})` : ""}`))
          showToast(res.healed ? "🔧 Готово" : "Восстановление не выполнено", res.healed ? "success" : "error")
        } catch (e: any) {
          await log("heal failed", { error: e?.message || String(e) })
          setParts(svc(`ошибка восстановления: ${e?.message || e}`))
          showToast(`Ошибка восстановления: ${e?.message || e}`, "error")
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
        showToast(helpText)
        setParts(svc(helpText))
        return
      }

      // /voice <file.wav> — распознать готовый аудиофайл
      if (parts.length && (parts[0].endsWith(".wav") || parts[0].endsWith(".mp3") || parts[0].endsWith(".m4a") || parts[0].endsWith(".ogg") || parts[0].endsWith(".flac"))) {
        const file = parts[0]
        const resolved = file.startsWith("/") ? file : `${directory}/${file}`
        showToast("Распознаю аудио…")
        try {
          const { transcribe, stripNonSpeech } = await import("./lib/stt")
          const raw = await transcribe({
            backend: state.backend,
            language: state.language,
            device: state.device,
            file: resolved,
            $,
            source: "command-file",
          })
          const text = stripNonSpeech(raw)
          append(text)
          setParts(text)
          showToast("Готово", "success")
        } catch (e: any) {
          await log("transcribe file failed", { error: e?.message || String(e) })
          showToast(`Ошибка: ${e?.message || e}`, "error")
          setParts(svc(`/voice ${file}: ошибка распознавания — ${e?.message || e}`))
        }
        return
      }

      // /voice — запись до тишины (жёсткий предел: OPENCODE_VOICE_MAX_RECORD_SECONDS)
      // -> распознавание -> текст в поле ввода.
      // При сбое — авто-восстановление (doctor.sh --fix) и одна повторная попытка.
      // При окончательной ошибке хук бросает исключение: иначе OpenCode отправит
      // заглушку ("\n") и модель получит пустой запрос.
      try {
        const rec = await import("./lib/recorder")
        const { transcribe, stripNonSpeech } = await import("./lib/stt")
        const { beep } = await import("./lib/beep")

        const recordOnce = async () => {
          await beep($, 880, 120)
          const s = await rec.startPushToTalk($)
          const info = await rec.waitPushToTalkAuto(s)
          await beep($, 520, 140)
          await log("ptt recorded", { reason: info.reason, audioMs: Math.round(info.audioMs) })
          return s
        }

        const attempt = async (): Promise<string> => {
          let session = await recordOnce()
          if (rec.pttFileSize(session.file) < 2000) {
            // Аудиоканал WSLg отвалился — один раз пересоздаём и пробуем снова.
            await log("ptt no audio, recovering", { file: session.file })
            showToast("🔄 Микрофон не отвечает — пересоздаю аудиоканал…")
            await rec.recoverMic($)
            session = await recordOnce()
          }
          if (rec.pttFileSize(session.file) < 2000) {
            throw new Error("пустая запись (микрофон молчит)")
          }

          showToast("🧠 Распознаю речь…")
          let raw: string
          try {
            raw = await transcribe({
              backend: state.backend,
              language: state.language,
              device: state.device,
              file: session.file,
              $,
              source: "command",
            })
          } catch (e: any) {
            throw new Error(`ошибка распознавания: ${e?.message || e}`)
          }
          const text = stripNonSpeech(raw)
          if (!text) throw new Error("речь не распознана (только шум)")
          return text
        }

        let text: string | null = null
        let lastError: Error | null = null
        for (let i = 0; i < 2 && text === null; i++) {
          try {
            text = await attempt()
          } catch (e: any) {
            lastError = e instanceof Error ? e : new Error(String(e))
            if (i === 0) {
              await log("ptt attempt failed", { error: lastError.message })
              showToast(`⚠️ ${lastError.message} — пробую восстановить…`)
              const { heal } = await import("./lib/heal")
              const res = await heal($, { directory, reason: lastError.message, log })
              if (res.healed) {
                showToast("🔧 Канал восстановлен — повторяю запись…")
                continue
              }
            }
          }
        }
        if (text === null) {
          await log("ptt failed", { error: lastError?.message })
          showToast(`❌ ${lastError?.message || "не удалось распознать"}`, "error")
          throw lastError || new Error("ptt: не удалось распознать")
        }
        await beep($, 660, 120)
        append(text)
        setParts(text)
        showToast(`✅ Готово: "${text.slice(0, 40)}..."`, "success")
      } catch (e: any) {
        await log("ptt aborted", { error: e?.message || String(e) })
        throw e
      }
    },
  }

  return hooks
}