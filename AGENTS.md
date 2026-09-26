# OpenCode Voice Plugin — V2 Migration

> OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice2

Документ описывает Voice для OpenCode V2. Подробный срез миграции и матрица статусов находятся
в [`V2_MIGRATION.md`](V2_MIGRATION.md). Все пути в этом документе начинаются от корня
`<PROJECT_ROOT>`, если не указано иное.

## Текущий статус V2

- Проверенная версия OpenCode: **v2.0.15**.
- Server plugin `voice` загружается; команды `voice` и `v` зарегистрированы.
- Core port V2 работает для запуска, команд, PTT и кнопки расширения.
- Extension scope **least-privilege**: `content_scripts.matches` содержит только
  `http://localhost:*/*` и `http://127.0.0.1:*/*`; `<all_urls>` удалён, версия расширения `1.0.36`.
- `host_permissions` приведены к валидным match patterns: только `localhost` и `127.0.0.1`
  (записи вида `172.16.0.0/12` Chrome не понимает и Web Store отвергал сборку).
- Shell adapter **является** security boundary: `src/lib/shell.ts` передаёт значения как argv
  через `execFile` с `shell:false` и не использует `/bin/bash`.
- V2 bundle **автономен**: `sync-plugin.sh` поставляет entrypoints, `lib/`, `stt-server/`,
  `shared/`, `doctor.sh` и `fix-mic.sh`; launcher/`heal`/`whisper`/`text` ищут ресурсы
  относительно bundle, а не только относительно `cwd`.
- Физический `<leader>v` **подтверждён живьём**: TUI запущен в tmux, лидер — `ctrl+x`
  (совпадает с `ctrl+x l` / `ctrl+x m` в палитре); нажатие даёт тост, в открытой сессии
  запускает запись (`arecord` поднимается за 1 с).
- Серверный TTS **работает**: `piper-tts 1.8.0` + голос `ru_RU-irina-medium` (63 МБ) в
  `~/.local/share/opencode-voice/tts`; `/health` → `available: true`, `/speak` отдаёт WAV.
  Голос подхватывается автоматически, `setup.sh --tts` ставит Piper и голоса.
- Typecheck **автономен**: зависимости установлены через `npm ci` (420 пакетов,
  `package-lock.json` в репозитории), `npm run typecheck` → `tsc 5.9.3`, exit 0.
  Сторож `scripts/ensure-deps.mjs` роняет скрипт, если зависимостей нет.
- Hermetic-аудит на `@opencode/plugin 2.0.18` (поднят с `2.0.17`, диапазон в
  `package.json` остался `^2.0.0`): `npm ci` → 420 пакетов, `npm run verify` → exit `0`,
  145/145 node-тестов, pytest 75 collected. Утверждения о **живых** сессиях ниже
  по-прежнему относятся к `2.0.15` — на `2.0.18` перезапуск плагина, PTT, хоткей и TUI
  не перепроверялись.
- Репозиторий под git; CI в `.github/workflows/ci.yml`.
- Полная автономная V2 migration **не завершена**: остаются разница UX (auto-submit вместо
  вставки в редактор) и нежелательный model call для info-сабкоманд.

## Архитектура и источники истины

| Назначение | Путь | Роль |
| --- | --- | --- |
| Server entrypoint | `src/index.ts` | V2 plugin, команды и orchestration |
| Загружаемая server-копия | `.opencode/plugins/voice/index.ts` | Фактически загружается OpenCode из V2 bundle |
| TUI entrypoint | `src/tui.tsx` | CLI keymap и footer indicator |
| Загружаемая TUI-копия | `.opencode/plugins/voice/tui.tsx` | Фактически загружаемый TUI-модуль |
| Plugin libs | `src/lib/` | STT, recorder, shell, state, beeps, launcher, heal |
| STT server | `stt-server/stt_server.py` | HTTP STT и server-side recording |
| Extension | `extension/` | Кнопка Chrome для Web UI |
| Sync | `sync-plugin.sh` | Поставляет entrypoints, `lib/`, `stt-server/`, `shared/`, `doctor.sh`, `fix-mic.sh` |
| Правила для ассистента | `shared/tts-manifest.json` → `assistant.rulesMarkdown` | Текст правила «помечай 🔈 в каждом ответе» |
| Установка правил | `scripts/assistant-rules.mjs`, `setup.sh --rules` | Разворачивает правила в `~/.config/opencode/AGENTS.md` |
| Диагностика | `doctor.sh`, `fix-mic.sh` | Server/CORS/mic и восстановление |
| Skills | `.opencode/skills/` | 11 `ovi-*` skills; см. [`SKILLS_GUIDE.md`](SKILLS_GUIDE.md) |
| Migration report | `V2_MIGRATION.md` | Evidence, статусы и remaining tasks |
| Fix log | `FIXES.md` | Что чинили, почему, и разбор ошибок для будущей установки |

`.opencode/plugins/voice/` — это loaded bundle, а не отдельный глобальный V1-каталог. Он
поставляется целиком: `sync-plugin.sh` копирует entrypoints, `lib/`, `stt-server/`,
`shared/`, `doctor.sh` и `fix-mic.sh`, а `bash sync-plugin.sh --check` проверяет каждый файл
и возвращает exit `1` при расхождении. Launcher, `heal`, `whisper` и `text` ищут ресурсы
относительно bundle, поэтому bundle работает независимо от `cwd` процесса.

## V2 server entrypoint и команды

Server entrypoint намеренно экспортирует working plain object без value-импорта
`@opencode/plugin`:

```ts
export default {
  id: "voice",
  async setup(ctx) {
    // ...
  },
}
```

Такой default export нужен V2 loader; value-импорт заставил бы loader пытаться собирать
`node_modules` проекта. `@opencode/plugin` остаётся зависимостью для типов и отдельной
TUI-части, но не импортируется как value в server entrypoint.

Команды регистрируются синхронно через callback transform, без отдельного идентификатора transform:

```ts
ctx.command.transform((editor) => {
  editor.add({ name: "voice", description, execute })
  editor.add({ name: "v", description, execute })
})
```

`execute` получает `{ sessionID, prompt, delivery }`. Аргументы читаются из
`invocation.prompt.text`; тяжёлая запись и распознавание выполняются внутри async `execute`.
Выполнения последовательны, чтобы вторая команда не прерывала первую запись.

TUI-клиент вызывает серверную команду через
`context.client.session.command({ sessionID, name: "voice", text: "/voice" })`. TUI source и
loaded copy синхронизированы; sync entrypoints проверен, но чистая V2 TUI/typecheck проверка
не зафиксирована, внешняя проверка не автономна. В target `@opentui` symlinks указывают на
V1 deps `0.4.5`, package заявляет `^0.5.12`, а `@opencode/plugin 2.0.15` ожидает peer
`>=0.5.10`; TUI load evidence смешанный. Физическое нажатие `<leader>v` отдельно в live-логах
не зафиксировано, поэтому hotkey имеет статус «историческая сверка есть, чистая V2 проверка и
физический хоткей не подтверждены». `🎤` в `prompt.footer.status` — индикатор, не кликабельная
кнопка.

## Семантика результата команды

Текущий V2-путь отправляет распознанный текст в сессию:

```ts
ctx.session.prompt({ sessionID, text, delivery })
```

Для `/voice` и `/voice <file>` это означает **auto-submit**: текст становится следующим user
prompt и передаётся модели. Это не вставка только в редактор. Поэтому в документации,
TUI-описаниях и migration report нужно говорить «отправляет транскрипт в сессию/модели» и
явно называть такую UX-адаптацию частичной.

Info-сабкоманды `backend`, `lang`, `device`, `help`, `doctor` и `heal` работают, но их
служебный текст `svc(...)` тоже проходит через `ctx.session.prompt`. Поэтому модель может
ответить даже на служебное сообщение (в live-проверке `/voice backend` получен ответ
«Принято.»). Запрос не пустой, но это нежелательный дополнительный model call именно для
info-сабкоманды; для PTT/file auto-submit call является частью выбранного V2 поведения.

## Команды

- `/voice` — запись с микрофона, auto-stop после тишины, STT и отправка транскрипта в
  сессию/модели. Не обещать вставку в поле.
- `/voice <file.wav|mp3|m4a|ogg|flac>` — распознавание файла и отправка результата в
  сессию/модели.
- `/voice backend [local|api]` — показать/переключить STT backend.
- `/voice lang [ru|en|auto]` — показать/установить язык.
- `/voice device [auto|gpu|cpu]` — показать/выбрать локальное устройство.
- `/voice doctor [--fix]` — запустить `doctor.sh` и показать краткий вывод.
- `/voice heal` — ручное восстановление сервера/аудиоканала.
- `/voice help` — показать список возможностей.

Состояние `backend`/`lang`/`device` хранится через `src/lib/state.ts` в
`OPENCODE_VOICE_STATE_FILE` (по умолчанию `~/.config/opencode-voice/state.json`); переменные
окружения имеют приоритет.

## Skill routing

Перед работой загрузить соответствующий skill через штатный инструмент `skill`.

| Область | Skill |
| --- | --- |
| Обзор Voice, компоненты и поток аудио/текста | `ovi-overview` |
| V2 entrypoint, команды, recorder, STT, launcher | `ovi-plugin` |
| `stt-server/stt_server.py`, endpoints, token, CORS, logs | `ovi-server` |
| Chrome extension, кнопка, popup, `content.js`, CORS | `ovi-extension` |
| Whisper models, CPU/GPU, качество и скорость | `ovi-models` |
| PulseAudio, `audin`, silence, форматы и `fix-mic.sh` | `ovi-audio` |
| Token, bind, CORS, retention и secrets | `ovi-security` |
| `Failed to fetch`, auth, silence, медленный канал и doctor | `ovi-debug` |
| TTS, Piper, `/speak`, voices и popup | `ovi-tts` |
| Установка, env, config и onboarding | `ovi-setup` |
| Build, tests, sync, release и документация | `ovi-dev` |

## Agent workflow

Локальные subagents находятся в `.opencode/agents/` и вызываются как
`@voice-builder`, `@voice-verifier`, `@voice-code-reviewer` и
`@voice-security-auditor`. Для текущего V2 root команды и paths в их инструкциях должны
использовать `<PROJECT_ROOT>` или root-relative варианты.

Обязательный pipeline для каждого изменения:

```text
@voice-builder → @voice-verifier → @voice-code-reviewer → @voice-security-auditor → commit
```

`@voice-builder` — единственная write-capable роль; verifier, code-reviewer и security-auditor
работают read-only и должны выдать `APPROVE` перед commit. `@voice-stt` — optional/local STT
helper вне обязательного четырёхролевого pipeline. Описание V2 не возвращает V1 plugin/TUI API.
Уже выполненный ранее docs pipeline этим правилом не отменяется.

## STT, auth и качество

- Текущий live backend: `faster-whisper 1.2.1`, модель `small`, CPU.
- Для текущего CPU default — `small`; `medium` можно выбрать явно, но это не default для
  этой машины и требует больше ресурсов/времени.
- `stt_server.py` V2 и V1-path совпадают байт-в-байт.
- Server по умолчанию слушает `127.0.0.1` и разрешает CORS только для локальных origins.
- `OPENCODE_VOICE_TOKEN` необязателен. Если он задан, `/health` остаётся без токена, а
  остальные endpoints требуют `X-Voice-Token` или Bearer; значение в popup должно совпадать.
- `OPENCODE_VOICE_MODEL=whisper-1` относится только к OpenAI API; local faster-whisper/
  whisper.cpp используют `WHISPER_MODEL`/`WHISPER_CPP_MODEL_SIZE` и related local path variables.
- В текущем doctor server/CORS/mic исправны (delivery `0.86x`, peak `318`, RMS `25`).
  Server TTS закрыт: Piper и голос `ru_RU-irina-medium` установлены, `/speak` возвращает
  валидный WAV. Ранее единственным сбоем был `available=false` без Piper.
- `small` на CPU — ограничение качества/скорости, а не дефект V2-порта.
- `OPENCODE_VOICE_RETAIN_SECONDS<=0` не удаляет сразу, а отключает scheduled cleanup;
  TTS cache eviction — по размеру, purge пропускает `tts-*`, `voice-tts.log` не имеет
  автоматической retention/rotation.

## Deployment: закрыто, что осталось проверить

Cwd-dependent deployment gap закрыт:

- `server-launcher.ts` (`serverScript()`) ищет `stt-server/stt_server.py` и относительно
  bundle (`<here>/../stt-server/`), и относительно исходников (`<here>/../../`);
- `heal.ts` (`doctorScript()`) ищет `doctor.sh` в bundle и в `directory`;
- `whisper.ts` и `text.ts` (`loadSpec()`) читают `../shared/stt-spec.json` из bundle;
- `stt_server.py` (`_load_manifest()`) читает `../shared/tts-manifest.json` тем же путём
  (`parents[1]/shared`) и отдаёт его на `GET /manifest`. Ключи `$comment` — служебные
  пояснения для человека, наружу не отдаются. При битом JSON уходит в безопасный фолбэк,
  поэтому поломка манифеста выглядит как «озвучка перестала фильтровать», а не как ошибка;
- `test/deploy.test.mjs` валидирует **поставленный** bundle из постороннего temp-cwd: все
  ресурсы резолвятся внутри `.opencode/plugins/voice/`, а Python-путь `parents[1]/shared`
  совпадает с TS-путём `../shared`.

`bash sync-plugin.sh --check` подтверждает совпадение 20 файлов и завершается exit `0`.

Что всё ещё нельзя объявлять готовым: UX-разница (auto-submit вместо вставки в редактор)
и нежелательный model call для info-сабкоманд. Typecheck и серверный TTS закрыты.
Подробности — [`V2_MIGRATION.md`](V2_MIGRATION.md).

## Plugin/TUI restart

Плагин, TUI и config-time артефакты загружаются при старте. После изменения plugin/TUI/service
конфигурации нужен restart OpenCode и перезапуск загруженного TUI/service клиента. Старый
TUI-клиент может сохранять прежнее состояние; это **вероятная прикладная причина** раннего
«пустого запроса», но не доказанный отдельный факт.

Прикладной сценарий, который действительно наблюдался: `state.json` был загрязнён
`backend=api` без `OPENAI_API_KEY`; после сброса в `local` и restart Voice заработал.

## Разработка и проверки

Команды ниже выполняются из `<PROJECT_ROOT>`:

```bash
cd <PROJECT_ROOT>
npm run dev              # фактический script: opencode
bash sync-plugin.sh --check
PATH=/tmp/node-v22.23.3-linux-x64/bin:$PATH npm test                 # текущий аудит: 145/145
python3 -m pytest        # текущий аудит: 75 collected, exit 0
```

- `npm run dev` запускает `opencode`; отдельный аргумент `--plugin .` в текущем `package.json`
  не используется.
- TUI plugin и server plugin нужно перезапустить/перезагрузить после sync или config-time
  изменений.
- `PATH=$HOME/.local/opt/node22/bin:$PATH npm test` — Node suite `node --experimental-strip-types --test`; текущий аудит: 145/145 на Node `22.23.1`. Node лежит в `~/.local/opt/node22` — НЕ в `/tmp`: `wsl --shutdown` чистит `/tmp` и уносит Node вместе с ним. `package.json.engines.node` поднят до `>=22.6.0` (реальный prerequisite флага `--experimental-strip-types`).
- `npm run verify` — sync --check + типы + 145 тестов + pytest одной командой.
- `pytest` — hermetic server suite; текущий аудит: 75 collected, exit 0; микрофон и модель не нужны.
- TypeScript: `npm run typecheck` в этом checkout **автономен** — `node_modules` установлен
  через `npm ci`, `package-lock.json` в репозитории, реально отрабатывает `tsc 5.9.3` с
  exit 0. Раньше скрипт печатал «tsc: not found» и при этом завершался кодом 0 — тихая
  поломка, из-за которой CI оставался зелёным на непроверенном коде. Теперь перед `tsc`
  работает сторож `scripts/ensure-deps.mjs`, который валит сборку с понятным текстом.
  Историческая внешняя проверка запускала Node 22 с
  external-resolution config `<EXTERNAL_TYPECHECK_CONFIG>` (typeRoots/paths к V1
  dependencies), завершилась exit `0`; это не автономная V2-проверка.
- `sync-plugin.sh --check` проверяет все 20 поставляемых файлов (entrypoints, `lib/`,
  `stt-server/`, `shared/`, `doctor.sh`, `fix-mic.sh`) и возвращает exit `1` при расхождении.

Подробный ручной и smoke-план: [`TEST_PLAN.md`](TEST_PLAN.md).

## Skills и агенты

Skills лежат в `.opencode/skills/`. В текущем проекте 11 навыков: `ovi-overview`,
`ovi-plugin`, `ovi-server`, `ovi-extension`, `ovi-models`, `ovi-audio`, `ovi-debug`,
`ovi-dev`, `ovi-security`, `ovi-tts`, `ovi-setup`. V2 подключает их нативным массивом
`skills` в конфигурации OpenCode; формат и текущие пути описаны в
[`SKILLS_GUIDE.md`](SKILLS_GUIDE.md). Не считать skills local-only только на основании старого
описания V1 `.gitignore`.

Локальные агенты находятся в `.opencode/agents/`; перед работой по областям загружаются
соответствующие `ovi-*` skills. Документационный отчёт по текущему срезу — `V2_MIGRATION.md`.
