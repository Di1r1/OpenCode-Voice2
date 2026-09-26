---
name: ovi-overview
description: Use when the question is about OpenCode Voice V2 as a whole — what it is, which components exist (plugin, STT server, browser extension/button, TUI/web UI), how audio and text flow, where files live, or which ovi-* skill to open next. Triggers "OpenCode Voice V2", "voice plugin", "voice button", "how does voice work", architecture.
license: MIT
compatibility: opencode
metadata:
  author: Di1r1
  audience: both
  workflow: orientation
---

# OpenCode Voice — V2 overview

Voice control for OpenCode. The TUI `/voice` path records and transcribes speech, then sends the
recognized text to the session/model as the next user prompt. The Chrome button is a separate
Web UI path and inserts its transcript into the editor.

## Components

| Component | Path | Role |
| --- | --- | --- |
| Plugin (server-side) | `src/index.ts` (working plain object `{ id, setup(ctx) }`, no value-import of `@opencode/plugin`) | Registers `/voice` + `/v` through `ctx.command.transform(editor => editor.add(...))` and performs recording/transcription |
| Plugin libs | `src/lib/{stt,recorder,beep,server-launcher,config,shell}.ts` | STT, recording, beeps, launcher, config, and V2 shell adapter |
| Loaded plugin copy | `.opencode/plugins/voice/` (index, tui, `lib/`, `stt-server/`, `shared/`, `doctor.sh`, `fix-mic.sh`) | The copy OpenCode actually loads; `sync-plugin.sh` supplies and `--check` verifies all 20 files |
| STT HTTP server | `stt-server/stt_server.py` | `/transcribe`, `/record/*`, `/beep`, `/health`; local Whisper |
| Chrome extension (button) | `extension/` | Browser capture and Web UI editor insertion |
| TUI plugin | `.opencode/plugins/voice/tui.tsx` | `<leader>v` route to the server command; `🎤` is a status indicator, not a clickable button |
| Scripts | `sync-plugin.sh`, `fix-mic.sh`, `doctor.sh` | Bundle sync/verify, WSLg repair, server/CORS/mic diagnosis |
| Docs | `V2_MIGRATION.md`, `AGENTS.md`, `TEST_PLAN.md` | V2 evidence, architecture, and smoke plan |

## Two capture paths

1. **TUI `/voice` (plugin):** `arecord -D pulse` (or ffmpeg) in WSL/Linux → local STT →
   `ctx.session.prompt({ sessionID, text, delivery })` → model. It does not merely put text in
   the editor; this is a partial UX difference from V1.
2. **Chrome button (extension):** the browser captures the mic on the Windows side, POSTs
   WebM/Opus to the local STT server, and the extension inserts the returned text into the Web
   UI prompt field.

The button bypasses WSLg/RDP `audin`; TUI recording depends on the local audio path. See
`ovi-debug` and `ovi-audio` for channel diagnosis.

## Current V2 caveats

- OpenCode `v2.0.15` loaded the server plugin and registered `voice`/`v`.
- Live PTT and button logs confirm end-to-end transcription; the exact evidence is in
  `V2_MIGRATION.md`.
- TUI has only a historical one-off headless comparison `14/14` without a saved reproducible
  artifact/command; TUI source and loaded copy are synchronized, but a clean V2 TUI/typecheck
  check is not recorded and the external check is not autonomous. Physical `<leader>v` is not
  independently confirmed in logs.
- The V2 local bundle still has a deployment gap: the running STT process was observed at the
  V1 path, and the loaded bundle lacks `stt-server/`/`doctor.sh`. Do not describe V2
  autostart/watchdog as autonomous until this is fixed.
- Server auth is optional. With `OPENCODE_VOICE_TOKEN`, `/health` is public but other endpoints
  require the matching token.

## Where to look next

| Question | Skill |
| --- | --- |
| Plugin internals, `/voice`, recorder, V2 prompt semantics | `ovi-plugin` |
| Server API, token, CORS, logs, deployment launcher | `ovi-server` |
| Button/extension, sounds, popup, version `1.0.54` | `ovi-extension` |
| Models, CPU/GPU, quality/speed tuning | `ovi-models` |
| Microphone/audio, silence, audin, formats | `ovi-audio` |
| Security/privacy, bind, retention, secrets | `ovi-security` |
| “It does not work”: fetch/auth/silence/slow channel | `ovi-debug` |
| Tests, sync, typecheck, docs, release | `ovi-dev` |
| TTS/Piper and read-aloud | `ovi-tts` |
| Install/onboarding | `ovi-setup` |

## Glossary

- **audin** — RDP Audio Input Redirection channel exposed by WSLg as `RDPSource`.
- **RDPSink.monitor** — system-sound loopback; it must not be used as the microphone.
- **Silence gate** — audio below configured peak/RMS thresholds is rejected before Whisper.
- **source=command / source=button** — origin tag in
  `/tmp/opencode/voice-recognized.log`.
- **Retention** — recordings live in RAM (`/dev/shm/opencode-voice`) and scheduled cleanup
  uses the configured interval; `<=0` disables scheduled cleanup and requires manual deletion.

For a complete status matrix and remaining migration work, read
`<PROJECT_ROOT>/V2_MIGRATION.md`.
