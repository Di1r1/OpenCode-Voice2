# OpenCode Voice Extension

> OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
>
> Текущая версия extension: **1.0.34**

Chrome-расширение (MV3) для голосового ввода в OpenCode Web UI: кнопка **🎤**, запись и
звуковые сигналы. Extension bundle и manifest намеренно держат одну версию: в
`extension/manifest.json` стоит `1.0.34`, а `extension/content.js` печатает
`content.js v1.0.34 loaded`.

## Архитектура

Запись гибридная, с двумя capture-путями:

1. **Основной — браузер.** `MediaRecorder` (`getUserMedia`) пишет WebM/Opus на стороне
   Windows и отправляет файл на STT server через `POST /transcribe`. RDP-канал `audin` при
   этом не используется.
2. **Фолбэк — server-side recording.** Если браузер не может писать, расширение вызывает
   `POST /record/start` и `POST /record/stop`; Python server пишет с микрофона через
   PulseAudio/`arecord`.

Схема локального пути:

```text
Chrome / OpenCode Web UI                  WSL / Linux
┌──────────────────────┐  HTTP            ┌─────────────────────────────┐
│ content.js           │ ────────────────► │ stt_server.py :8765          │
│ MediaRecorder/button │                  │ POST /transcribe             │
│ popup (token/beeps)  │ ◄── transcript ── │ POST /record/start|stop      │
└──────────────────────┘                  │ faster-whisper / whisper.cpp  │
                                          └─────────────────────────────┘
```

Кнопка вставляет распознанный текст в поле Web UI. Это отдельное поведение от TUI-команды
OpenCode V2: `/voice` в TUI отправляет транскрипт в сессию/модель как следующий prompt.

## Пути V2 checkout

Корень проекта:

```text
<PROJECT_ROOT>
```

- extension: `<PROJECT_ROOT>/extension/`
- STT server: `<PROJECT_ROOT>/stt-server/stt_server.py`
- loaded server plugin: `<PROJECT_ROOT>/.opencode/plugins/voice/index.ts`
- loaded TUI plugin: `<PROJECT_ROOT>/.opencode/plugins/voice/tui.tsx`

Команды ниже выполняются из project root, без старого V1-каталога.

## Установка и запуск сервера

### Ручной запуск V2 server

```bash
cd <PROJECT_ROOT>
pip install --no-input -r stt-server/requirements.txt
export PULSE_SERVER=unix:/mnt/wslg/PulseServer       # WSL2, если нужен этот путь
python3 stt-server/stt_server.py --model small --device cpu --compute-type int8 --port 8765
```

Для текущей CPU-конфигурации используется **`small`**. `medium` можно передать явно, если
достаточно памяти и времени, но называть `medium` default для этой машины нельзя: shared
конфигурация задаёт `small` для CPU и `medium` только для GPU-профиля.

По умолчанию server слушает `127.0.0.1:8765`; наружу не выставляется без явного
`OPENCODE_VOICE_HOST` и осознанного решения по сети. Extension в локальном Web UI
использует `127.0.0.1:8765` (для `localhost` это также снимает проблему IPv6 `::1`).

**Source debt:** комментарии `extension/content.js:5-6` всё ещё утверждают `0.0.0.0`, хотя
фактический default — `127.0.0.1`. Исправление оставляем runtime task; LAN `0.0.0.0`
допустим только явным решением с token, CORS не является authentication, а `/health` public.

Проверка:

```bash
curl -s http://127.0.0.1:8765/health
```

В текущем live-окружении ответ HTTP 200 содержит, в частности:

```text
faster-whisper 1.2.1
model=small
device=cpu
```

### Autostart V2: важная оговорка

Launcher/server-watchdog в текущем V2 checkout ещё не автономен. На момент проверки
работающий процесс был запущен из V1 path:

```text
<V1_PROJECT_ROOT>/stt-server/stt_server.py
```

Раньше loaded bundle не содержал `stt-server/` и `doctor.sh`. Теперь `sync-plugin.sh`
поставляет их вместе с entrypoints и `lib/`, а launcher ищет ресурсы относительно bundle, а
не только относительно `cwd`, поэтому ручной запуск и `OPENCODE_VOICE_SERVER_SCRIPT` больше не
обязательны. Проверить поставку: `bash sync-plugin.sh --check`. Подробности — в
[`../V2_MIGRATION.md`](../V2_MIGRATION.md).

### Загрузка extension в Chrome

1. `chrome://extensions/` → включить **Режим разработчика**.
2. **Загрузить распакованное расширение** → `<PROJECT_ROOT>/extension`.
3. После изменения `content.js` нажать **Reload**; также обновить вкладку Web UI.
4. Проверить в DevTools Console строку `[OpenCode Voice] content.js v1.0.34 loaded`.

### Использование кнопки

1. Открыть OpenCode Web UI (например, `http://localhost:4096/`).
2. Нажать 🎤 и сказать фразу.
3. Нажать кнопку ещё раз для остановки; при необходимости используется server-side fallback.
4. Проверить, что transcript вставлен в поле Web UI.

Popup содержит:

- поле токена доступа (`X-Voice-Token`), если сервер защищён;
- переключатель звуковых сигналов;
- проверку звука.

Токен не следует сохранять в репозитории, документации или issue. Если
`OPENCODE_VOICE_TOKEN` задан, `/health` открыт без токена, а остальные endpoints требуют
совпадающего значения в popup.

## STT API и CORS

| Метод | Путь | Назначение |
| --- | --- | --- |
| GET | `/health` | status, backend, model, device, recorder, `auth`, TTS status |
| POST | `/transcribe` | распознать загруженный аудиофайл (основной extension path) |
| POST | `/record/start` | начать server-side запись |
| GET | `/record/status` | проверить активную запись |
| POST | `/record/stop` | остановить и распознать запись |
| GET/POST | `/beep?freq=N` | сигнал; `freq=0` — только ping/version marker |

Extension отправляет `X-Voice-Source: button`, поэтому распознанный текст появляется в
`/tmp/opencode/voice-recognized.log` с `source=button`. CORS ограничен локальными origins и
`chrome-extension://…`; preflight должен разрешать `X-Voice-Source` и, при auth,
`X-Voice-Token`. Старый или неправильно запущенный server может дать `Failed to fetch`.

Диагностика из project root:

```bash
cd <PROJECT_ROOT>
bash doctor.sh
bash doctor.sh --fix
```

Не вставлять токены, ключи или полные credential-значения в команды, issue и отчёты.

## Автотесты и проверки

```bash
cd <PROJECT_ROOT>
bash sync-plugin.sh --check
PATH=/tmp/node-v22.23.3-linux-x64/bin:$PATH npm test                 # текущий аудит: 93/93
python3 -m pytest        # текущий аудит: 65 collected, exit 0
```

Тесты hermetic: не требуют микрофона и модели. TUI live smoke и deployment path описаны в
[`../TEST_PLAN.md`](../TEST_PLAN.md).

`PATH=/tmp/node-v22.23.3-linux-x64/bin:$PATH npm test` требует Node `22.23.3` (default Node
`v18` не подходит для `--experimental-strip-types`); `package.json.engines.node >=20` не
является достаточным prerequisite и исправляется отдельной future code/config task.

## TTS и ограничения

TTS — optional. Piper ставится через `./setup.sh --tts` и кладёт голоса в
`~/.local/share/opencode-voice/tts/`. После установки health сообщает:

```text
tts.enabled=true
tts.available=true
```

Проверить звук без браузера:

```bash
curl -s -X POST http://127.0.0.1:8765/speak \
  -H 'Content-Type: application/json' -d '{"text":"Проверка."}' -o /tmp/tts.wav
file /tmp/tts.wav     # RIFF ... WAVE audio
```

`small` на CPU ограничивает качество/скорость перевода, но не означает проблему V2 API или
миграции.

TTS cache eviction выполняется по размеру; purge пропускает `tts-*`; `voice-tts.log` не имеет
автоматической retention/rotation policy. Логи и cache могут содержать plaintext, поэтому
держать их в private/protected directory, применять `0600` where feasible, rotation/retention или
manual purge осознанно и redact перед sharing; настроенную rotation не обещать.

### Политика озвучки приезжает манифестом

Правила «что произносить» **не зашиты в расширение**. При старте `tts.js` один раз
тянет `GET /manifest` и применяет результат через `applyManifest()`:

| Поле манифеста | Что делает в расширении |
|---|---|
| `speak.marker` | заменяет константу `SPEAK_MARK` — метку можно сменить на любой символ |
| `alwaysVoicePrefixes` | `alwaysSpoken()` — эти строки звучат без метки, даже в `manual` |
| `neverVoicePatterns` | гасят строку, даже если метка стояла (код, ссылки, пути) |
| `speak.interChunkPauseMs` | пауза между фразами |

Порядок отбора в `pickSpoken()`: **маркер → обязательные префиксы → режим**. То есть
пометка 🔈 всегда важнее режима, а `alwaysVoicePrefixes` — страховка на случай забытой
метки.

Манифест подтягивается **до** старта опроса (`startTicking()`), иначе первый ответ успел бы
озвучиться по встроенным дефолтам. Если сервер недоступен или манифест битый — остаются
дефолты, расширение не падает. Диагностика: в отладке `manifest: загружен` / `manifest: дефолты`.

Правка политики — в `shared/tts-manifest.json`, затем `./sync-plugin.sh` и перезагрузка
расширения. Подробности — [INSTALL.md](../INSTALL.md#51-манифест-озвучки-что-произносить-а-что-нельзя).

## Если микрофон недоступен

В WSL2 `/dev/snd` может отсутствовать по дизайну; рабочий путь — PulseAudio:

```bash
export PULSE_SERVER=unix:/mnt/wslg/PulseServer
pactl info
pactl list short sources
arecord -D pulse -f S16_LE -r 16000 -c 1 -t wav -d 3 /tmp/voice-test.wav
```

`bash <PROJECT_ROOT>/fix-mic.sh` пересоздаёт WSLg-аудиоканал. Если server-side fallback
не записывает данные, сначала проверьте `doctor.sh`, источник PulseAudio и права Windows на
микрофон.

## Логи

- content script: DevTools Console, фильтр `[OpenCode Voice]`;
- server: `/tmp/opencode/stt_server.log`;
- extension requests: `/tmp/opencode/voice-requests.log`;
- transcript: `/tmp/opencode/voice-recognized.log` (`source=button` или `source=command`);
- plugin STT diagnostics: `/tmp/opencode/voice-stt.log`.

Plaintext risks include full transcripts in `voice-recognized.log`, transcript excerpts in
`stt_server.log`, request metadata in `voice-requests.log`, and TTS log/cache content. Redact
before sharing; no automatic rotation/retention is promised.

Живое подтверждение bundle: `manifest.json` = `1.0.34`, `content.js` = `v1.0.34`; кнопка
зафиксирована в log как `source=button` 24 сентября 2026.
