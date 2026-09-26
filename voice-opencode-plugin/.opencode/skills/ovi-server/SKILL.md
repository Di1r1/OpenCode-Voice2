---
name: ovi-server
description: Use when working with the OpenCode Voice V2 STT HTTP server — /health, /transcribe, /record/start|status|stop, /beep, access token, CORS allowlist, silence gate, autostart/watchdog, runtime checks, or reading its logs. Triggers stt_server.py, port 8765, /transcribe, X-Voice-Token, CORS, watchdog.
license: MIT
compatibility: opencode
metadata:
  author: Di1r1
  audience: developers
  workflow: server
---

# OpenCode Voice — STT server

File: `stt-server/stt_server.py`. Flask app, bound to `OPENCODE_VOICE_HOST` (default `127.0.0.1`)
and `OPENCODE_VOICE_PORT` (default `8765`). `server-launcher.ts` attempts to start and supervise
it, but the current V2 local bundle is not autonomous: with service `cwd=<SERVICE_CWD>` its
candidates do not find `<PROJECT_ROOT>/stt-server/stt_server.py`. The running live process
has been observed at the V1 path, so verify the process path and `/health` instead of assuming
V2 autostart. Controlled evidence: with `directory` and `cwd=<PROJECT_ROOT>` on temporary
port `8766` the loaded launcher found and started `<PROJECT_ROOT>/stt-server/stt_server.py`;
from actual `cwd=<SERVICE_CWD>` the same call returned `script not found`/`false`. The temporary
process was killed and port `8765` was untouched. This proves a cwd-dependent gap, not a missing
V2 file. Watchdog interval: `OPENCODE_VOICE_SERVER_WATCHDOG_MS`, default 120 s.

Manual start (detached):

```bash
cd <PROJECT_ROOT>
PULSE_SERVER=unix:/mnt/wslg/PulseServer python3 -u stt-server/stt_server.py --port 8765 \
  >> /tmp/opencode/stt_server.log 2>&1 < /dev/null &
```

## Endpoints

| Route | Methods | Notes |
| --- | --- | --- |
| `/health` | GET | `status, backend, model, device, recorder, pulse_server, fake_audio, python, auth` |
| `/transcribe` | POST | multipart `audio=@file` (WAV/WebM/Opus/…); returns `{text, language, language_probability, backend, model, duration}` |
| `/record/start` | POST | starts a server-side recording (409 if already recording) |
| `/record/status` | GET | `{recording: bool}` |
| `/record/stop` | POST | stops gracefully (SIGINT so the WAV header is written), transcribes, returns the result |
| `/beep?freq=880` | GET/POST | plays a tone in WSL; `freq<=0` only logs (used as a version ping) |

## Security

- **Optional access token**: if `OPENCODE_VOICE_TOKEN` is set, every route except `/health` and CORS
  preflight requires `X-Voice-Token: <token>` or `Authorization: Bearer <token>`; otherwise `401`.
  The Chrome popup stores the same token (`chrome.storage.local`).
- **CORS allowlist** (`_ALLOWED_ORIGIN`): `localhost`, `127.0.0.1`, RFC1918 hosts and
  `chrome-extension://[a-p]{32}`. `Access-Control-Allow-Headers` must include
  `Content-Type, X-Voice-Token, Authorization, X-Voice-Source` — the extension sends `X-Voice-Source`,
  so a stale server without it makes the button fail with `Failed to fetch`.

## Transcription pipeline

1. Non-WAV input is converted with ffmpeg to 16 kHz mono WAV (`_to_wav`).
2. **Silence gate**: below `OPENCODE_VOICE_SILENCE_PEAK` (700) and `_RMS` (80) → `text=""`, Whisper is not run.
3. Backend `OPENCODE_VOICE_STT_BACKEND` (`whispercpp|faster-whisper|auto`, default auto):
   whisper.cpp CLI with `-mc 0 -sns` (fewer hallucinations) or faster-whisper (CPU, lazy import).
4. `_strip_non_speech()` removes `[музыка]`/`(смех)`/`♪` markers.
5. Result is appended to `OPENCODE_VOICE_RECOGNIZED_LOG` with the request's `X-Voice-Source`
   (default `api` for `/transcribe`, `button` for `/record/stop`).

## Server env

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENCODE_VOICE_HOST` / `_PORT` | `127.0.0.1` / `8765` | Bind address |
| `OPENCODE_VOICE_TOKEN` | — | Optional shared secret |
| `OPENCODE_VOICE_STT_BACKEND` | auto | `whispercpp` \| `faster-whisper` |
| `OPENCODE_VOICE_LANGUAGE` | auto | `ru`/`en`/… pins the language (skips detection) |
| `OPENCODE_VOICE_MODEL` | `whisper-1` | OpenAI API model id only; it is not a local model/path selector |
| `WHISPER_MODEL` / `WHISPER_CPP_MODEL_SIZE` | local backend setting | Local faster-whisper/whisper.cpp model or size; do not substitute `OPENCODE_VOICE_MODEL` |
| `WHISPER_CPP_BIN`/`_MODEL`/`_LIB_DIR`/`_EXTRA_LIBS` | `~/.local/share/opencode-voice/whisper/...` | whisper.cpp binary, model, CUDA libs |
| `WHISPER_MODEL` | `small` on the current CPU; `medium` is an explicit/GPU option | faster-whisper model size |
| `WHISPER_BEAM_SIZE`, `WHISPER_VAD`, `WHISPER_INITIAL_PROMPT` | `1`, on, empty | Accuracy/speed tuning |
| `OPENCODE_VOICE_SILENCE_PEAK` / `_RMS` | `700` / `80` | Silence gate |
| `OPENCODE_VOICE_SOURCE` | `RDPSource` | PulseAudio capture source |
| `OPENCODE_VOICE_TMP_DIR` | `/dev/shm/opencode-voice` | Uploads/recordings (RAM) |
| `OPENCODE_VOICE_RETAIN_SECONDS` | `300` | Scheduled cleanup age; `<=0` disables scheduled delete, so manual deletion is required |
| `OPENCODE_VOICE_KEEP_AUDIO` | — | Keep files for debugging |
| `OPENCODE_VOICE_FAKE_AUDIO` | — | Fixture path: full fake record cycle without a mic (tests) |
| `OPENCODE_VOICE_RECOGNIZED_LOG` | `/tmp/opencode/voice-recognized.log` | Transcript log |
| `OPENCODE_VOICE_AUTO_RECOVER`, `WSLG_RESTART_*_WAIT`, `WSL_EXE` | on, 8/5 s | WSLg channel auto-recovery |

## Logs

- `/tmp/opencode/stt_server.log` — startup runtime checks (Python, CUDA driver, recorder, whisper.cpp/model, PULSE socket) and every request/transcription.
- `/tmp/opencode/voice-requests.log` — who called the server (`origin`, user-agent).
- `/tmp/opencode/voice-recognized.log` — final transcripts with `source=`/`backend=`/`dur=`.

## Tests

Hermetic pytest suite (no mic, no model): `cd <PROJECT_ROOT> && python3 -m pytest -q`
(`stt-server/tests/test_server.py`, 75 tests; current audit: 75 collected, exit 0). `pytest.ini`
lives in `<PROJECT_ROOT>/`.
