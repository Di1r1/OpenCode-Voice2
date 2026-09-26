---
name: ovi-tts
description: "Use when working with TTS read-aloud of assistant answers in OpenCode Voice V2 — extension/tts.js engines, server POST /speak with Piper, chunking, stuck-speech watchdog, popup TTS settings. Keywords: tts, speak, озвучка, Piper, utteranceBudget, primeAudio, /voices."
---

# TTS (озвучка ответов)

Аддитивный opt-in слой: финальные ответы ассистента озвучиваются либо
браузером (Web Speech), либо сервером (Piper → WAV, **проигрывает браузер**).
Источник текста — опрос same-origin API web-UI (`GET /api/session` →
`GET /session/{id}/message`), SSE `/api/event` — опционален.

## 1. Где что (источник истины)

| Часть | Файл | Ключевое |
|---|---|---|
| Движки, очередь, чанкинг, сторож | `extension/tts.js` | `speak()` роутит по `ttsEngine`; `chunkSentences` ≤180; `utteranceBudget` 10–60 с |
| Настройки | `chrome.storage.local` (`tts*`), `extension/popup.*` | `ttsEngine` browser/server, `ttsVoice` vs `ttsServerVoice` (разные ключи!) |
| Серверный синтез | `stt-server/stt_server.py` (`/speak`, `/voices`) | текст на `stdin` Piper, whitelist `*.onnx`, LRU-кэш, семафор (429 при занятости) |
| Голоса | `$OPENCODE_VOICE_HOME/tts/voices/` | RU: 4 голоса; EN: `en_US-lessac-medium` (см. `ovi-setup`) |
| Логи | `/tmp/opencode/voice-tts.log` | `cache=hit/miss`, ошибки синтеза |

TTS lifecycle: cache eviction is size-based, server purge skips `tts-*`, and
`/tmp/opencode/voice-tts.log` has no automatic retention/rotation. Manual purge/retention is
required where needed; do not promise time-based deletion.

## 2. Обязательный порядок действий

1. Загрузи этот скилл (уже), при серверных правках — ещё и `ovi-server`.
2. Движок `server`: текст чанкуется клиентом (`mode:"full"` на сервер,
   сервер повторно не укорачивает); лимит `OPENCODE_VOICE_TTS_MAX_CHARS`
   обойти чанками, а не поднятием лимита.
3. Заголовок `X-Voice-Source: tts` обязан побеждать `button` из `authHeaders()`
   (`Object.assign({}, authHeaders(), {...tts})`) — иначе неверный source в логах.
4. Проверки: `GET /voices` (каталог), `POST /speak` → 200 + WAV
   (`curl ... -o /tmp/tts-test.wav -w "%{http_code}\n"`), `PATH=$HOME/.local/opt/node22/bin:$PATH npm test`
   (паритет `cleanForSpeech`), `pytest -k speak` (помни про затык с живыми
   голосами — см. `ovi-dev`).

## 3. Частые ошибки

- `501 tts disabled` → сервер стартовал без `OPENCODE_VOICE_TTS=1` (флаг читается один раз
  при старте). В текущем V2 audit `tts.enabled=true`, но `tts.available=false`: Piper
  отсутствует; launcher/resource deployment gap также не закрыт.
- `413 text too long` → слать чанками, фолбэк остатка — на браузер, не всё заново.
- `401` → токен popup ≠ `OPENCODE_VOICE_TOKEN` сервера.
- Тишина без ошибок только на вкладке OpenCode → залипший процесс рендера:
  очередь `speechSynthesis`/`AudioContext` переживают F5; сторож даёт
  `cancel()` + ретрай, при повторе — тост «закройте вкладку полностью».
  Это не чинится кодом TTS — только новым процессом вкладки.
- Нет жеста пользователя → `AudioContext` suspended (серверный WAV глушится),
  браузерный движок откладывает в `pending`; лечится кликом (`primeAudio`).
- Английский текст русским голосом Piper — мусор: голос сервера под язык
  авто не подбирается, выбор — в дропдауне popup (`ttsServerVoice`).

## 4. Чек-лист

- [ ] оба движка проверены отдельно; состояние server TTS **не предполагать**, а проверить:
      `curl -s http://127.0.0.1:8765/health` → `tts.available`. `available: false` означает, что
      Piper не установлен (лечится `setup.sh --tts`), и это не дефект кода
- [ ] длинные ответы идут чанками, без `413`
- [ ] `PATH=$HOME/.local/opt/node22/bin:$PATH npm test` + `pytest -k speak` зелёные (с учётом затыка живых голосов)
- [ ] версия расширения поднята (`manifest.json` + лог в `content.js`); запись о релизе
      добавлена в `V2_MIGRATION.md` либо `CHANGELOG.md` создан только отдельной задачей (в
      текущем `openvi2` его нет)
