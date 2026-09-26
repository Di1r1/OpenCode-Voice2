---
name: ovi-audio
description: "Использовать при проблемах со звуком и качеством распознавания в OpenCode Voice V2 — микрофон молчит, «Аудиоисточник молчит», тишина, обрезанная запись, плохое качество по RDP, неправильный источник (RDPSource / Stereo Mix), форматы и уровни, fix-mic.sh, doctor.sh, autocтоп и порог тишины. Ключевые слова: микрофон, silence, audin, PulseAudio, arecord, peak, RMS, доставка, RDP, fix-mic, doctor."
license: MIT
compatibility: opencode
metadata:
  author: Di1r1
---

# Звуковой тракт: микрофон, запись, качество

Микрофон идёт через PulseAudio; в WSL2 — через WSLg и RDP-канал `audin`. Именно здесь ломается чаще всего, и «плохое распознавание» почти всегда означает плохой вход, а не плохую модель.

## 1. Где правят (источник истины)

| Слой | Файл | Что важно |
|---|---|---|
| Рекордер плагина | `src/lib/recorder.ts` | `startPushToTalk`, `waitPushToTalkAuto` (авто-стоп по тишине, жёсткий предел 300 с), мягкая остановка SIGINT, формат `S16_LE 16k mono`, `OPENCODE_VOICE_SOURCE`, ретеншен `/dev/shm` |
| Серверная запись | `stt-server/stt_server.py` | `_record_cmd` (`arecord -D pulse -f S16_LE -r 16000 -c 1`), `MAX_SECONDS` (300), `_wav_levels`/`_is_silent`, `_wslg_restart` |
| Порог тишины | `src/lib/stt.ts` + `stt_server.py` | `OPENCODE_VOICE_SILENCE_PEAK=700` / `_RMS=80`; ниже обоих — «без речи» |
| Ремонт канала | `fix-mic.sh` | Пересоздаёт WSLg (weston + pulseaudio) |
| Диагностика | `doctor.sh` | Порт/health/CORS, зависшая запись, проба микрофона (пик/RMS/доставка) |
| Браузерный путь | `extension/` | Захват в браузере → `/transcribe`, **минуя** `audin` |

## 2. Аудио-пути (ключевое различие)

1. **`/voice` (плагин)** — `arecord` в WSL/Linux. По RDP звук идёт через `audin`, который может отдавать сэмплы **медленнее реального времени** (замеряли ~0.38×) → качество страдает.
2. **Кнопка 🎤 (расширение)** — браузер пишет на стороне Windows и загружает файл на сервер (`/transcribe`), `audin` не участвует → по RDP качество заметно выше.

Диагноз «канал медленный»: сравните скорость доставки и уровни (см. §4). Норма — доставка ≈1.0×, RMS ~2500–3100, пик ~22000–23000 при обычной речи.

## 3. Типовые симптомы

| Симптом | Причина | Что делать |
|---|---|---|
| `Нет доступа к микрофону: PulseAudio не отвечает` | рекордер не подключился | проверить `PULSE_SERVER`, `pactl info`, перезапустить канал (`fix-mic.sh`) |
| `Аудиоисточник молчит … (0 байт)` | `audin` отвалился | `fix-mic.sh`; сервер сам лечится один раз (`OPENCODE_VOICE_AUTO_RECOVER=1`) |
| Хвост записи обрезан | раньше `SIGKILL`; теперь — мягкий SIGINT | убедиться, что версия с `waitPushToTalkAuto` актуальна |
| Распознаётся «мусор»/музыка | запись идёт с `RDPSink.monitor` (loopback) | задать `OPENCODE_VOICE_SOURCE` на микрофон (Linux: `pactl get-default-source`) |
| Тишина → выдуманный текст | Whisper галлюцинирует на тишине | порог тишины (уже включён), `-mc 0 -sns` для whisper.cpp |
| По RDP плохо, по кнопке хорошо | слабый `audin` | так и есть: используйте кнопку или локальный микрофон |

## 4. Проверки

```bash
export PULSE_SERVER=unix:/mnt/wslg/PulseServer     # WSL2

pactl list short sources            # Linux/WSL: имя источника, формат
pactl get-default-source

# проба записи 5 c + метрики (доставка = длительность аудио / настенное время)
arecord -D pulse -f S16_LE -r 16000 -c 1 -t wav -d 5 /tmp/t.wav
python3 - <<'PY'
import wave,array
w=wave.open('/tmp/t.wav'); a=array.array('h'); a.frombytes(w.readframes(w.getnframes()))
print('dur=%.2fs peak=%d rms=%.0f'%(len(a)/w.getframerate(), max(abs(x) for x in a), (sum(x*x for x in a)/len(a))**0.5))
PY

bash doctor.sh          # сводка + проба микрофона
bash doctor.sh --fix    # ремонт (сервер, зависшая запись, канал)
```

Ожидаемые ориентиры при обычной речи: пик ≈ 20 000–23 000, RMS ≈ 2500–3100, доставка ≈ 1.0×. Тишина: пик < 700 и RMS < 80.

В текущем V2 deployment gap loaded plugin не содержит `stt-server/`/doctor resources, а
launcher может искать server script относительно `<SERVICE_CWD>`; перед диагностикой кнопки
проверяйте фактический process path.

## 5. Частые ошибки

- Править модель, когда виноват вход: сначала §4, потом `ovi-models`.
- Проверять `/dev/snd` в WSL2 — его там нет по дизайну (`no soundcards found`), это не поломка.
- Забыть `OPENCODE_VOICE_SOURCE` на Linux (дефолт `RDPSource` — только для WSLg).
- Ждать «живой таймер» записи в TUI: хук блокирующий, таймера нет (см. `ovi-plugin`).
- `OPENCODE_VOICE_KEEP_AUDIO` без нужды — записи перестанут удаляться.

## 6. Чек-лист

- [ ] `pactl info` отвечает, источник — микрофон (не `*.monitor`)
- [ ] проба `arecord` пишет реальный файл (не 44 байта) с уровнем ≈ нормы
- [ ] доставка ≈ 1.0× (медленнее → канал/RDP-клиент, см. `ovi-debug`)
- [ ] `doctor.sh` зелёный
- [ ] при галлюцинациях — порог тишины и `-mc 0 -sns` на месте
