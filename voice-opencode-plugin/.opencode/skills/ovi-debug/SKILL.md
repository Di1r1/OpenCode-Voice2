---
name: ovi-debug
description: Use when OpenCode Voice V2 misbehaves — the extension button says "Failed to fetch", 401/409 errors, /voice hangs or returns no speech, the mic is silent or the channel is slow, transcripts are garbled, or you need doctor.sh/fix-mic.sh and log locations. Triggers Failed to fetch, mic does not work, no speech, silence, already recording, audin, fix-mic, doctor, troubleshooting.
license: MIT
compatibility: opencode
metadata:
  author: Di1r1
  audience: both
  workflow: troubleshooting
---

# OpenCode Voice — diagnostics and repair

## First tool: `doctor.sh`

```bash
cd <PROJECT_ROOT>
bash doctor.sh          # read-only diagnosis
bash doctor.sh --fix    # + auto-repair
```

Checks: server process/port/`health`, **CORS for `X-Voice-Source`**, stuck recording,
mic probe (delivery ratio + peak/rms), log freshness. Repairs: restart the server via the watchdog,
`POST /record/stop` for a stuck recording, `fix-mic.sh` when the channel is dead. In the current
V2 checkout, verify the process path first: the loaded bundle lacks the server resources and the
launcher may not find the V2 script with service `cwd=<SERVICE_CWD>`.
Inside OpenCode: `/voice doctor` and `/voice doctor --fix` (summary lands in the prompt).

## Symptom → cause → fix

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Button: `Failed to fetch` | server not listening, **or** CORS missing `X-Voice-Source` (stale server after an extension update) | `./doctor.sh`; restart the server (`--fix`) |
| Button: `401` | `OPENCODE_VOICE_TOKEN` set on the server but not in the popup (or different) | Put the same token in the extension popup |
| Button: `409 already recording` | a previous server-side recording never stopped | `POST /record/stop` (doctor `--fix`) |
| `/voice`: "речь не распознана: тишина" | digital silence: dead audin channel, muted mic, or the silence gate | `fix-mic.sh`, `doctor.sh`; increase `OPENCODE_VOICE_SILENCE_*` only if the mic is genuinely quiet |
| `/voice`: garbage / hallucination on silence | Whisper inventing text | Silence gate + `-mc 0 -sns` are on; lower `OPENCODE_VOICE_SILENCE_PEAK/_RMS` if real quiet speech is being dropped |
| `/voice` long wait, then truncated audio | old behaviour: SIGKILL at 35 s while RDP delivered slower than realtime | Fixed in code (auto-stop by silence + graceful SIGINT). Restart OpenCode to load it |
| Slow, low-level capture over RDP | third-party RDP client captures on the browser main thread (~85 ms buffers, AEC/AGC on) → ~0.4× realtime | Use the native client or the extension button; a Windows-side WASAPI agent is the radical fix |
| Sounds missing (extension) | Chrome kept an old `content.js` | `chrome://extensions` → Reload, then F5 |
| `/voice doctor` unknown | plugin copy predates the command | Restart OpenCode (config-time change) |
| Plugin not loaded at all | stale/mismatched synced copy | `bash sync-plugin.sh --check` (20 files), then restart; also check the log line `loading plugin` — `/api/plugin?directory=...` ignores its param in v2.0.15, so query `/api/plugin` without it |
| Extension still shows the mic button on unrelated sites | Chrome kept the old bundle with `<all_urls>` | Reload the extension in `chrome://extensions` (v1.0.35) |

## Repairing the WSLg audio channel

```bash
./fix-mic.sh    # kills weston, then pulseaudio; WSLGd restarts them; then tests 3 s of arecord
```

The plugin also does this automatically once per `recordOnce()` when the recording comes back empty
(`recoverMic`, `OPENCODE_VOICE_AUTO_RECOVER=1`). Manual recipe:
`wsl.exe --system -e sh -lc 'pkill -9 -x weston'` → wait ~8 s → `… 'pkill -9 -x pulseaudio'` → wait ~5 s.

## Measuring the capture channel

`<EXTERNAL_DIAG_ROOT>/measure.sh` и `<EXTERNAL_DIAG_ROOT>/` — optional/reference
external paths, не гарантированные артефакты target. Перед использованием проверяйте:

```bash
if [[ -x <EXTERNAL_DIAG_ROOT>/measure.sh ]]; then
  cd <EXTERNAL_DIAG_ROOT>
  SOURCE=RDPSource SECONDS=30 ./measure.sh out.wav
else
  echo 'SKIP optional measure.sh; use doctor.sh or local arecord probe'
fi
```

Fallback — `bash <PROJECT_ROOT>/doctor.sh` или локальный `arecord` probe. Prints audio
duration, wall time, **delivery ratio** (~1.0× expected), RMS and peak. Reference values with
a healthy channel: ratio ≈ 0.95–1.0×, RMS 2500–3100, peak 22000–23000 on speech. A low ratio
means the RDP client is dropping buffers (not the model); near-zero peak means the channel is
dead.

## Logs

| File | What it shows |
| --- | --- |
| `/tmp/opencode/stt_server.log` | startup runtime checks + every request/transcription (`Transcribed via …`) |
| `/tmp/opencode/voice-requests.log` | who called the server (`origin`, user-agent) |
| `/tmp/opencode/voice-recognized.log` | final text with `source=command|button backend=… model=… lang=… dur=…` |
| `/tmp/opencode/voice-stt.log` | plugin-side backend choice and audio levels (`peak/rms/silent`) |
| `~/.local/share/opencode/log/opencode.log` | plugin `log()` events; `level=ERROR` lines when `/voice` throws (no speech/error) |
| `/mnt/wslg/wlog.log` | WSLg/FreeRDP. `ReceiveSamples failed with error 1359` also happens with mstsc at stream stop — not a reliable criterion |

`~/.local/share/opencode/log/opencode.log` и `/mnt/wslg/wlog.log` — optional external/reference
paths; перед чтением проверяйте `[[ -e ... ]]`, иначе используйте доступные V2 logs.

## RDP specifics

- WSLg exposes the mic as PulseAudio `RDPSource` (audin channel); `RDPSink.monitor` is system sound and must never be picked (`OPENCODE_VOICE_SOURCE` pins it).
- The capture source is chosen on the **client** side (Windows mic settings / client UI), not in WSL.
- Comparison measured here: a web-based third-party client delivered ~0.38× realtime with −7 dB and dropouts; the native client delivered 0.95× and full levels (verbatim transcription). The browser **extension** bypasses WSLg entirely and is the most reliable path over RDP.
