---
name: ovi-models
description: Use when choosing or tuning STT models/backends, setting up GPU (CUDA toolkit, whisper.cpp build, GTX 950M / CC 5.0), switching GPU↔CPU, or measuring quality/speed for OpenCode Voice. Triggers whisper.cpp, ggml model, faster-whisper, CUDA, nvcc, GPU, model quality, beam, VAD, transcription speed.
license: MIT
compatibility: opencode
metadata:
  author: Di1r1
  audience: both
  workflow: models
---

# OpenCode Voice — models, GPU and tuning

## Backends

| Backend | Where | Typical use |
| --- | --- | --- |
| `whispercpp` | `WHISPER_CPP_BIN` + GGML model, GPU via CUDA | Default when a CUDA driver and the CLI/model exist |
| `faster-whisper` | Python, CPU (`pip install faster-whisper`) | Текущий CPU default — `small`; `medium` можно выбрать явно |
| `python-whisper`, `vosk` | Python | Last-resort fallbacks |
| OpenAI API | `OPENCODE_VOICE_BACKEND=api` + `OPENAI_API_KEY` + `OPENCODE_VOICE_MODEL` (`whisper-1`) | No local compute; `OPENCODE_VOICE_MODEL` is API-only |

Selection: `OPENCODE_VOICE_DEVICE=auto|gpu|cpu` (or `/voice device …`).
`OPENCODE_VOICE_STT_BACKEND=whispercpp|faster-whisper` is a legacy alias. Model variables are
scope-specific: `OPENCODE_VOICE_MODEL` is for the OpenAI API only; local faster-whisper/whisper.cpp
use `WHISPER_MODEL`, `WHISPER_CPP_MODEL_SIZE` and related `WHISPER_CPP_*` path variables.
`auto` = GPU if `libcuda` is present, otherwise CPU; an explicit `gpu` never silently falls back.

## Installed layout (optional/reference paths)

```
~/.local/share/opencode-voice/whisper/
  bin/whisper-cli, lib*.so*    # whisper.cpp built with CUDA
  ggml-medium.bin              # GPU/явный профиль
  ggml-small.bin               # текущий CPU default/fallback
~/cuda-12.6/                   # user-space CUDA Toolkit (no root)
```

Эти пути — optional/reference/external prerequisites, а не гарантированные файлы target
`<PROJECT_ROOT>`. Перед GPU/CUDA примерами проверяйте existence; fallback — CPU
faster-whisper или пропуск GPU-профиля:

```bash
for p in "$HOME/.local/share/opencode-voice/whisper/bin/whisper-cli" \
         "$HOME/cuda-12.6/lib64" /tmp/opencode/gpu_util.py; do
  [[ -e "$p" ]] && printf 'present: %s\n' "$p" || printf 'SKIP optional: %s\n' "$p"
done
```

`LD_LIBRARY_PATH` when running the CLI applies only if those optional paths exist:
`<bin> : ~/cuda-12.6/lib64 : /usr/lib/wsl/lib`.

## GPU notes (WSL2, GTX 950M, CC 5.0)

- WSL CUDA needs a modern Windows driver exposing `/usr/lib/wsl/lib/libcuda.so*` (the 2017 driver did not).
- **CUDA 13 cannot compile Maxwell (CC 5.0)** — use the 12.x toolkit. Install into `$HOME` (runfile with
  `--toolkit --toolkitpath=$HOME/cuda-12.6 --no-opengl-libs --no-man-page --override`, `DISPLAY=` set).
- Build whisper.cpp:

```bash
cmake -B build-cuda -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=50 -DCMAKE_BUILD_TYPE=Release \
  -DWHISPER_BUILD_TESTS=OFF -DCUDAToolkit_ROOT=$HOME/cuda-12.6 \
  -DCMAKE_CUDA_FLAGS=-allow-unsupported-compiler \
  -DCMAKE_EXE_LINKER_FLAGS="-L$HOME/cuda-12.6/lib64 -Wl,--copy-dt-needed-entries -Wl,-rpath,$HOME/cuda-12.6/lib64"
```

- Measure GPU load with NVML (`/tmp/opencode/gpu_util.py`); a running transcript shows 85–100 % util and ~0.9 GB VRAM for the small model on this GPU.

## Tuning defaults (both plugin and server)

| Setting | Default | Note |
| --- | --- | --- |
| OpenAI `OPENCODE_VOICE_MODEL` | `whisper-1` | Только `backend=api`; не задаёт локальный путь/размер |
| Local `WHISPER_MODEL` / `WHISPER_CPP_MODEL_SIZE` | `small` на текущем CPU; `medium` для GPU/явного выбора | Локальный faster-whisper/whisper.cpp; `small` быстрее, `medium` обычно качественнее, но требует больше ресурсов |
| `WHISPER_BEAM_SIZE` | `1` (greedy) | beam 5 is ~30 % slower with marginal gain |
| `WHISPER_VAD` | on | VAD filter for faster-whisper |
| `WHISPER_INITIAL_PROMPT` | empty | A default Russian prompt caused misrecognitions ("проверка"→"прайберка") |
| whisper.cpp flags | `-mc 0 -sns` | no context carry-over, suppress non-speech tokens |
| Plugin `OPENCODE_VOICE_LANGUAGE` | `ru` | V2 plugin default (`DEFAULTS.sttLanguage`); `ru` skips detection (~25–30 % faster) and avoids word reordering |
| Server `OPENCODE_VOICE_LANGUAGE` unset | `auto` | Python server default when the environment variable is absent; this is separate from the plugin default |
| Silence gate | peak 700 / rms 80 | Silence is rejected before Whisper (anti-hallucination) |

Важно: `ru` — default language plugin path; server при unset `OPENCODE_VOICE_LANGUAGE` использует
`auto`. Эти два default-значения нельзя объединять в один.

Measured on a synthetic or consented, redacted reference fixture
(`<REFERENCE_TRANSCRIPT>`): medium returns the redacted fixture content with `ru` or `auto`,
with or without `-mc 0 -sns`; the flags mainly cut hallucinations on noise, not word accuracy.
Speed on this CPU/GPU is dominated by captured-audio length; the GPU keeps 5-second clips
around 5 s total. This fixture is synthetic or consented/redacted and contains no published
speech or transcript payload; do not replace the placeholder with one in public documentation.

## How to A/B a model

```bash
W=~/.local/share/opencode-voice/whisper/bin/whisper-cli
M=~/.local/share/opencode-voice/whisper/ggml-medium.bin
LD_LIBRARY_PATH=~/.local/share/opencode-voice/whisper/bin:~/cuda-12.6/lib64:/usr/lib/wsl/lib \
  $W -m $M -f sample.wav -l ru -nt -np
# add -mc 0 -sns to match production, or drop them to compare
```

Compare on files with known content (e.g. a 5–10 s clip you read aloud) and always re-check duration
and levels — a truncated or low-level file will look like a "model problem" when it is a capture problem
(see `ovi-debug`).
