---
name: ovi-plugin
description: Use when editing or debugging the OpenCode Voice V2 plugin itself — the V2 entrypoint, /voice subcommands, recorder (auto-stop by silence, graceful SIGINT, RAM tmp dir, retention), beeps, logRecognized, server launcher, sync-plugin.sh and the loader quirk. Triggers src/index.ts, recorder.ts, stt.ts, /voice command, push-to-talk.
license: MIT
compatibility: opencode
metadata:
  author: Di1r1
  audience: developers
  workflow: implementation
---

# OpenCode Voice — V2 plugin internals

## Entry and loaded copy

Source of truth for the server plugin: `src/index.ts`. OpenCode actually loads
`.opencode/plugins/voice/index.ts`; the TUI copy is `.opencode/plugins/voice/tui.tsx`.

The server entrypoint is intentionally a plain object:

```ts
export default {
  id: "voice",
  async setup(ctx) {
    // ...
  },
}
```

There is no value-import of `@opencode/plugin` in the server entrypoint. Such an import made
the loader try to resolve/build the project `node_modules`; the package dependency remains a
development/type dependency, not a runtime server import.

`sync-plugin.sh` supplies the **whole** bundle: entrypoints (`index.ts`, `tui.tsx`), `src/lib/*.ts`,
`stt-server/`, `shared/`, `doctor.sh` and `fix-mic.sh` (20 files). `bash sync-plugin.sh --check`
verifies each file and exits `1` on drift. The launcher, `heal`, `whisper` and `text` resolve
resources relative to the bundle (e.g. `../stt-server/`, `../shared/stt-spec.json`), not only
relative to `cwd`, so V2 autostart works from any service cwd. `test/deploy.test.mjs` asserts
this against the shipped bundle from a foreign temp cwd. After changing runtime files, run
`sync-plugin.sh`, then restart OpenCode and the TUI client.

## Command registration and V2 semantics

Registration is synchronous and has no transform ID:

```ts
ctx.command.transform((editor) => {
  editor.add({ name: "voice", description, execute })
  editor.add({ name: "v", description, execute })
})
```

`execute` receives `{ sessionID, prompt, delivery }`. It parses `prompt.text`, removes an
optional `/voice` prefix, and performs the operation in the async callback. Executions are
serialized; a second `/voice` does not interrupt a recording in progress.

The result path is:

```ts
ctx.session.prompt({ sessionID, text, delivery })
```

For a successful PTT/file transcription, `text` is sent to the session/model as the next user
prompt. It is not a promise that text is inserted into the TUI editor. This is a partial UX
adaptation from V1 and must be described truthfully in docs. The current source comments/help
text still contain some older editor-insertion wording; treat that as follow-up debt, not as
the documented V2 contract.

Info subcommands `backend`, `lang`, `device`, `help`, `doctor` and `heal` work, but their
service text is also sent with `ctx.session.prompt`; the model can respond to it. In a live
check `/voice backend` produced “Принято.”. This is a non-empty request but an undesirable
additional model call **for the info path**, not a PTT failure. The PTT/file model call is part
of the selected V2 auto-submit behavior; its UX debt is the difference from V1 editor insertion.

Критическая ошибка PTT бросается из `execute`, а ошибка файлового пути возвращается как
служебный текст; plugin не отправляет намеренно пустой transcript. Shell adapter —
`src/lib/shell.ts` (`node:child_process`, `.text()` и `.quiet()`), заменяющий Bun `$`.

**Shell adapter is a security boundary (P0 fixed).** `src/lib/shell.ts` больше не
конкатенирует values и не вызывает `/bin/bash`: literal-части tagged-шаблона токенизируются,
каждое подставленное значение становится ровно одним argv-аргументом (массивы разворачиваются
в несколько), запуск идёт через `execFile` с `shell:false`. Shell-встроенные (`command -v`,
`which`, `test -x/-f/-d`) реализованы нативно, потому что внешних бинарников для них нет;
`resolveBin()` обходит `PATH`. Покрыто `test/shell.test.mjs` (13 тестов): payload с
metacharacters остаётся одним аргументом, маркерный файл не создаётся. Попутно исправлен скрытый
баг: `WHISPER_CPP_EXTRA_FLAGS` — `string[]`, и старый код склеивал его в один аргумент.
**Не возвращаться** к конкатенации строк или `exec` с shell.

## Subcommands

| Command | Behaviour |
| --- | --- |
| `/voice` | Record, auto-stop after silence (default hard cap `OPENCODE_VOICE_MAX_RECORD_SECONDS=300`), transcribe, and send transcript to session/model |
| `/voice <file.wav\|mp3\|m4a\|ogg\|flac>` | Transcribe an existing file (`source=command-file`) and send result to session/model |
| `/voice backend [local\|api]` | Show/change STT backend |
| `/voice lang [ru\|en\|auto]` | Show/change recognition language |
| `/voice device [auto\|gpu\|cpu]` | Show/change local device selection |
| `/voice doctor [--fix]` | Run `doctor.sh` and return a short diagnostic tail |
| `/voice heal` | Run manual recovery (`doctor.sh --fix` or fallback) |
| `/voice help` | Show the command list |

State persists through `src/lib/state.ts` in `OPENCODE_VOICE_STATE_FILE` (default
`~/.config/opencode-voice/state.json`); environment variables win at startup. A polluted
`backend=api` state without `OPENAI_API_KEY` can look like a broken empty request; reset to
`local` and restart before diagnosing V2.

## TUI client

`.opencode/plugins/voice/tui.tsx` calls the registered server command with:

```ts
context.client.session.command({ sessionID, name: "voice", text: "/voice" })
```

The TUI keymap defines `<leader>v`. There was a historical one-off headless comparison `14/14`,
without a saved reproducible test artifact/command. TUI source and loaded copy are synchronized;
sync entrypoints are checked, but a clean V2 TUI/typecheck check is not recorded and the external
check is not autonomous. A physical keypress was not independently recorded in live logs. The
`🎤` element in `prompt.footer.status` is a status indicator, not a clickable button. Config-time
plugin/TUI changes require restart; an old TUI client may retain prior state.

## Recording

`src/lib/recorder.ts`:

- `startPushToTalk($, { maxSeconds })` starts detached `arecord -D pulse -f S16_LE -r 16000 -c
  1 -t wav` (ffmpeg fallback) and returns `{ file, pid, backend }` immediately.
- Files use `${OPENCODE_VOICE_TMP_DIR:-/dev/shm/opencode-voice}/voice-ptt-*.wav` and are
  scheduled for deletion after `OPENCODE_VOICE_RETAIN_SECONDS` (default 300 s); a value `<=0`
  disables scheduled cleanup, so manual deletion is required.
- `waitPushToTalkAuto()` stops after 1500 ms silence once speech was seen, or at the audio/wall
  limit. The default hard audio cap is 300 s, configurable with
  `OPENCODE_VOICE_MAX_RECORD_SECONDS`.
- `stopGracefully()` sends SIGINT so `arecord` finalizes the WAV header; SIGKILL is only a
  fallback.
- `PULSE_SOURCE` is pinned from `OPENCODE_VOICE_SOURCE` (default `RDPSource`) so a dead `audin`
  path cannot silently select the system-sound monitor.
- `recoverMic()` recreates the WSLg audio channel once when a recording is empty.

## STT

`src/lib/stt.ts` exposes `transcribe({ backend, language, file, $, device, source })` and logs
results through `logRecognized()` to `OPENCODE_VOICE_RECOGNIZED_LOG` (default
`/tmp/opencode/voice-recognized.log`) as `source= backend= model= lang= dur= text=...`.

Current live CPU path: `faster-whisper 1.2.1`, model `small`, device `cpu`. The normal fallback
order includes whisper.cpp GPU, faster-whisper CPU, whisper.cpp CPU, CLI engines, and other
optional backends. `isSilentWav()` rejects silence before Whisper; `stripNonSpeech()` removes
music/laughter markers. `small` on CPU is a quality/latency limitation, not a V2 migration
failure.

## Other libraries

- `beep.ts` generates and plays the start/stop/done WAV signals through `aplay -D pulse`,
  `paplay` or `ffplay`.
- `server-launcher.ts` exposes `ensureSttServer()` and `startServerWatchdog()`. It searches an
  explicit script path, package-relative candidates, and cwd/directory candidates. In the
  current loaded V2 bundle those candidates do not find
  `<PROJECT_ROOT>/stt-server/stt_server.py` when service cwd is `<SERVICE_CWD>`; the running
  server observed at the V1 path does not make V2 autostart autonomous. Controlled test with
  `directory`/`cwd=<PROJECT_ROOT>` on temporary port `8766` did find and start the V2
  script, while the same call from `<SERVICE_CWD>` returned `script not found`/`false`; the temporary
  process was killed and `8765` was untouched.
- `config.ts` reads `OPENCODE_VOICE_BACKEND`, `OPENCODE_VOICE_LANGUAGE`, model and API-key
  settings. `OPENCODE_VOICE_MODEL` is the OpenAI API model id only; local paths use
  `WHISPER_MODEL`/`WHISPER_CPP_MODEL_SIZE` and related `WHISPER_CPP_*` variables. Never put an
  API key or token in documentation.

## Server and auth caveat

The Python server defaults to `127.0.0.1`, answers CORS for local origins, and can be protected
by `OPENCODE_VOICE_TOKEN`. `/health` is public; other endpoints require the token when it is
configured. The V2 `stt_server.py` is byte-for-byte identical to the V1 server file, so the
current blocker is deployment/launcher wiring rather than a Python STT port.

## Rules

- Keep server `setup()` a plain object and keep command registration synchronous.
- Do not add a separate `commands.voice` config entry; the plugin owns `voice` and `v`.
- Keep `src/index.ts` and `.opencode/plugins/voice/index.ts` synchronized; sync does not copy
  `lib/` or server resources.
- Config-time plugin/TUI changes require restart; do not infer a stale TUI client as proven
  root cause without live evidence.
- For migration status and remaining work, read
  `<PROJECT_ROOT>/V2_MIGRATION.md`.
