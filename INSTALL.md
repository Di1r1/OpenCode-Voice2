# Установка OpenCode Voice

> OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice

Полная инструкция для чистой машины. Проверено на OpenCode **v2.0.15**, WSL2 (Ubuntu) и
Windows. Команды выполнять **из корня проекта**.

---

## 0. Что понадобится

| Компонент | Версия | Зачем | Проверка |
|---|---|---|---|
| **Node.js** | **22.6+** (проверено 22.23.3) | тесты и `typecheck`; флаг `--experimental-strip-types` появился в 22.6 | `node -v` |
| **Python** | 3.10+ (проверено 3.12) | STT-сервер (`faster-whisper`) | `python3 -V` |
| `alsa-utils` | любая | `arecord` / `aplay` для микрофона и бипов | `which arecord aplay` |
| Chrome | любой | кнопка микрофона на веб-интерфейсе | — |

> ⚠️ **Важно про Node.** `package.json` требует `>=22.6.0`, и это не формальность: на Node 20
> тесты падают с `bad option: --experimental-strip-types`. Если у вас Node 18 или 20 —
> поставьте 22 через [nodejs.org](https://nodejs.org) или `nvm install 22`.

```bash
# Debian/Ubuntu: системные утилиты для звука
sudo apt-get install -y alsa-utils libasound2-plugins
```

---

## 1. Получить проект и поставить зависимости

```bash
git clone https://github.com/Di1r1/OpenCode-Voice2.git
cd OpenCode-Voice2

npm ci            # есть package-lock.json — строго по нему
# или, если lock-файла нет:  npm install
```

### Если `npm ci` падает с `EACCES: permission denied, rename ...`

Проект лежит на Windows-томе (`/mnt/c/...`, файловая система `v9fs`), где npm не может
переименовывать каталоги во время атомарной замены. Решение — перенести проект в
файловую систему Linux:

```bash
cp -r /mnt/c/temp/openvi2 ~/projects/opencode-voice
cd ~/projects/opencode-voice && rm -rf node_modules && npm ci
```

Так делать нужно **до** установки, иначе зависимости встанут неполными.

### Проверка, что зависимости на месте

```bash
npm run typecheck
```

Ожидается строка `✓ зависимости на месте (typescript 5.9.3, node v22.23.3)`.

Если вместо этого `✗ Зависимости не установлены` — вернитесь к `npm ci`.
Этот сторож специально добавлен: раньше `typecheck` при отсутствующем `tsc` печатал
«tsc: not found» и **при этом завершался с кодом 0**, то есть CI оставался зелёным
на непроверенном коде.

---

## 2. Установить Voice «под ключ»

```bash
./setup.sh --all
```

Что делает:

1. проверяет системные зависимости и звук;
2. ставит Python-пакеты (`faster-whisper`);
3. ставит `node`-зависимости;
4. генерирует bundle плагина в `.opencode/plugins/voice/`;
5. вписывает плагин в конфиг OpenCode **с бэкапом**;
6. прогоняет `doctor.sh`.

Отдельные шаги, если нужно поштучно:

| Команда | Что делает |
|---|---|
| `./setup.sh --check` | только проверить окружение, ничего не менять |
| `./setup.sh` | зависимости Python + node + синхронизация плагина |
| `./setup.sh --write-config` | вписать пути в конфиг OpenCode |
| `./setup.sh --tts` | скачать Piper и голоса для серверной озвучки |
| `./setup.sh --gpu` | собрать whisper.cpp с CUDA (быстрее распознавание) |
| `./setup.sh --model-size medium` | размер ggml-модели для `--gpu` |

---

## 3. Плагин в OpenCode — как подключается

Установщик (`--all` / `--write-config`) делает это сам. Если запускали без флагов,
добавьте руками в `~/.config/opencode/opencode.json` **или** `opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    { "package": "file:///ABSOLUTE/PATH/OpenCode-Voice2/.opencode/plugins/voice", "options": {} }
  ],
  "skills": ["/ABSOLUTE/PATH/OpenCode-Voice2/.opencode/skills"]
}
```

Ключевые моменты:

- **Путь абсолютный** и через `file://` — OpenCode не разрешает относительные пути.
  Симлинки Windows-пути вида `/mnt/c/...` работают, если WSL запущен.
- Указывается **bundle** `.opencode/plugins/voice`, а не папка проекта: именно bundle
  грузит OpenCode. Файл `index.ts` там появляется после `sync-plugin.sh`.
- **Блок `commands` не нужен.** Команды `/voice` и `/v` регистрирует сам плагин
  (`ctx.command.transform`). Старый V1-стиль `"plugin": [...]` не подходит для V2.
- `skills` — чтобы работали скиллы `ovi-*` (диагностика, STT, безопасность).

### ⚠️ Не оставляйте два файла конфига

OpenCode читает и `opencode.json`, и `opencode.jsonc`. Если существуют оба, поведение
становится непредсказуемым — плагин то подключается, то нет. Оставьте **один**:

```bash
ls ~/.config/opencode/opencode.json*
# свести к одному: удалить лишний, предварительно слив содержимое
```

### Проверка, что плагин загрузился

```bash
opencode plugin list
# должен быть голос "voice" с путём .../.opencode/plugins/voice
```

---

## 4. Расширение Chrome (кнопка микрофона)

1. Откройте `chrome://extensions`
2. Включите **«Режим разработчика»** (справа сверху)
3. **«Загрузить распакованное расширение»**
4. Выберите папку, где лежит `manifest.json`:

   **Windows:** `C:\путь\к\OpenCode-Voice2\extension`
   **WSL:** `\\wsl.localhost\<дистрибутив>\путь\к\OpenCode-Voice2\extension`

5. В `chrome://extensions` проверьте: имя **OpenCode Voice**, версия **1.0.36**

Консоль на странице OpenCode при загрузке печатает:

```
[OpenCode Voice] content.js v1.0.36 loaded
```

Если версия меньше — браузер держит старую копию, нажмите **Reload** у расширения.

### Настройка

Откройте popup расширения:

- **адрес STT-сервера** — `127.0.0.1:8765` (по умолчанию);
- **движок озвучки** — `Браузер` или `Сервер` (нужен Piper, см. §5);
- **«Отладка»** — включите, если что-то не работает: причина появится в консоли.

> Если сервер доступен не только с localhost, задайте `OPENCODE_VOICE_TOKEN` — без него
> любой в сети может писать с микрофона и читать расшифровки. CORS не является аутентификацией.

---

## 5. Серверная озвучка (TTS, опционально)

```bash
./setup.sh --tts
```

Кладёт Piper и голоса в `~/.local/share/opencode-voice/tts/`. Голос **подхватывается
автоматически** — докачивать вручную ничего не нужно. Проверка:

```bash
curl -s http://127.0.0.1:8765/health | python3 -m json.tool | grep -A3 tts
# "available": true
```

Проверить звук без браузера:

```bash
curl -s -X POST http://127.0.0.1:8765/speak \
  -H 'Content-Type: application/json' \
  -d '{"text":"Проверка озвучки."}' -o /tmp/tts.wav
file /tmp/tts.wav     # должно быть: RIFF ... WAVE audio
```

---

## 6. Запуск

```bash
opencode serve --hostname 127.0.0.1
```

Плагин поднимает STT-сервер сам при первом обращении. В логах должно появиться:

```
[voice] stt server ready
```

### В WSL

```bash
export PULSE_SERVER=unix:/mnt/wslg/PulseServer   # уже делает launcher
```

---

## 7. Проверка: всё работает?

```bash
npm test                 # 93/93
python3 -m pytest -q     # 65 passed
bash sync-plugin.sh --check   # OK по всем файлам bundle
npm run typecheck        # exit 0
```

Внутри OpenCode:

| Действие | Ожидание |
|---|---|
| `/voice help` | список команд Voice |
| `/voice doctor` | диагностика, в конце `Итог: проблемы — нет` |
| `<leader>v` (лидер по умолчанию `ctrl+x`) | запись с микрофона |
| кнопка 🎤 в браузере | запись и вставка текста |

---

## 8. Если что-то не работает

> Полный разбор всех симптомов, которые встречались при настройке, и их решений —
> в [`FIXES.md`](FIXES.md), часть 5. Здесь только быстрый путь.

### Микрофон молчит, бипов нет

Симптом: `Connection refused` от PulseAudio, `arecord` не пишет.

```bash
./fix-mic.sh
```

Если не помогло — из **Windows PowerShell**:

```powershell
wsl --shutdown
```

Это пересоздаёт Weston и PulseAudio. После перезапуска WSL поднимайте сервер заново.

### `Failed to fetch` в popup

Сервер не слушает порт либо CORS не разрешает origin. Проверьте:

```bash
curl -s http://127.0.0.1:8765/health
./doctor.sh            # покажет состояние сервера, CORS и микрофона
```

### 401 Unauthorized

Токен в popup не совпадает с `OPENCODE_VOICE_TOKEN` на сервере. Либо уберите токен
(только localhost), либо задайте один и тот же.

### 409 `already recording`

Зависшая запись. Лечится:

```bash
curl -s -X POST http://127.0.0.1:8765/record/stop
./doctor.sh --fix
```

### Плагин не грузится

```bash
bash sync-plugin.sh            # пересобрать bundle
opencode plugin list           # есть ли voice
```

И проверьте логи: `~/.local/share/opencode/log/opencode.log`. Ищите
`failed to load plugin` — там будет причина.

> **Важно:** TUI-клиент, открытый до рестарта сервера, держит старое состояние. После
> перезапуска откройте новую сессию — иначе команда будет «не срабатывать сразу».

---

## 9. Перенос на другую машину — краткий чеклист

```bash
git clone https://github.com/Di1r1/OpenCode-Voice2.git
cd OpenCode-Voice2
npm ci
./setup.sh --all          # зависимости + плагин в конфиге OpenCode
./setup.sh --tts          # озвучка (по желанию)
opencode serve --hostname 127.0.0.1
```

Затем вручную: Chrome → `chrome://extensions` → распаковать `extension/`.

Не переносятся и должны ставиться заново (это не баги, а нормально):

| Что | Где живёт | Почему не в git |
|---|---|---|
| `node_modules` | в проекте | восстанавливается через `npm ci` |
| Piper + голоса | `~/.local/share/opencode-voice/tts` | крупные бинарные файлы |
| модель Whisper | `~/.local/share/opencode-voice/whisper` | сотни МБ |
| токен/состояние | `~/.config/opencode-voice/state.json` | секреты и локальные настройки |
| конфиг OpenCode | `~/.config/opencode/opencode.json` | путь к плагину у каждого свой |
| расширение Chrome | профиль браузера | ставится через `chrome://extensions` |

---

## Что где лежит

| Назначение | Путь |
|---|---|
| Исходники плагина | `src/index.ts`, `src/tui.tsx`, `src/lib/` |
| **Загружаемый bundle** | `.opencode/plugins/voice/` — его и грузит OpenCode |
| STT-сервер | `stt-server/stt_server.py` |
| Общие спецификации | `shared/stt-spec.json`, `shared/tts-cases.json` |
| Расширение Chrome | `extension/` |
| Установщик | `setup.sh` |
| Диагностика | `doctor.sh`, `fix-mic.sh` |
| Отчёт о миграции | [`V2_MIGRATION.md`](V2_MIGRATION.md) |
| Правила работы над кодом | [`AGENTS.md`](AGENTS.md) |
| План тестов | [`TEST_PLAN.md`](TEST_PLAN.md) |
