// OpenCode Voice V2 (CLI) — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice2
// TUI-часть: хоткей <leader>v и индикатор 🎤 вызывают серверную команду /voice.
// V2 CLI API: https://opencode.ai/v2/docs/build/plugins/cli
// Запись/распознавание выполняет серверная часть (src/index.ts).
import { Plugin } from "@opencode/plugin/tui"

export default Plugin.define({
  id: "voice.tui",
  setup(context) {
    const runVoice = async (sessionID: string | undefined) => {
      if (!sessionID) {
        context.ui.toast.show({ message: "Voice: нет активной сессии", variant: "error" })
        return
      }
      try {
        // Серверная команда зарегистрирована плагином voice (ctx.command.transform).
        await context.client.session.command({ sessionID, name: "voice", text: "/voice" })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        context.ui.toast.show({ message: `Voice: ${msg}`, variant: "error" })
      }
    }

    const currentSessionID = (): string | undefined => {
      try {
        const route = context.ui.router.current()
        return route.type === "session" ? route.sessionID : undefined
      } catch {
        return undefined
      }
    }

    // keymap.layer обязан вызываться внутри компонента (reactive owner):
    // регистрируем слой из render-функции слота "app" (паттерн из CLI-доков).
    context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "voice.pushToTalk",
              title: "Voice: записать и распознать в промпт",
              group: "Voice",
              bind: "<leader>v",
              run: () => runVoice(currentSessionID()),
            },
          ],
          bindings: ["voice.pushToTalk"],
        }))
        return null
      },
    })

    // Индикатор в строке статуса промпта (терминал: только текст, без кликов).
    const removeSlot = context.ui.slot({
      append: "prompt.footer.status",
      render: () => <text>🎤</text>,
    })

    return () => {
      try {
        removeSlot()
      } catch {
        // best-effort
      }
    }
  },
})
