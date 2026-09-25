# OpenCode Voice V2 — отчёт о миграции

**Срез проверки:** 24–25 сентября 2026  
**Корень проекта:** `<PROJECT_ROOT>`  
**Проверенная версия OpenCode:** `v2.0.15`

## Краткий вывод

Портирование ядра Voice на V2 **частично успешно**: серверный плагин загружается, команды
`voice` и `v` зарегистрированы, живые push-to-talk и кнопка расширения доходят до STT и
возвращают распознанный текст. Это подтверждено не только кодом, но и живыми записями в
`/tmp/opencode/voice-recognized.log`.

Это **не полностью автономная миграция V2**, но все три ранее блокирующих вопроса закрыты
в текущем проходе (см. «Закрытые P0-блокеры» ниже). Остаются два незакрытых вопроса:

1. V2-команда отправляет транскрипт в сессию и сразу запускает модель, а не вставляет его
   в редактор. Это рабочий, но частично адаптированный UX относительно V1.
2. Физическое нажатие `<leader>v` не подтверждено отдельным живым событием, а качество STT
   ограничено моделью `small` на CPU.

Итоговая классификация: **ядро V2 — работает; P0-блокеры безопасности и поставки закрыты;
полная автономная V2 migration — не завершена** (UX-контракт и часть debt-обязательств
остаются).

## Закрытые P0-блокеры (runtime-правки этого прохода)

В отличие от предыдущего docs-only прохода, здесь менялся **runtime-код**, конфигурация
расширения и тесты. Закрыто три блокера:

1. **Shell injection — закрыт.** `src/lib/shell.ts` переписан: значения больше не
   конкатенируются в строку и не уходят в `/bin/bash`. Каждое подставленное значение
   становится ровно одним argv-аргументом (массивы разворачиваются в несколько), запуск идёт
   через `execFile` с `shell:false`. Shell-встроенные команды (`command -v`, `test -x/-f/-d`)
   реализованы нативно. Попутно исправлен скрытый баг: `WHISPER_CPP_EXTRA_FLAGS` —
   это `string[]`, и старый код склеивал его в один аргумент.
2. **Extension scope — закрыт.** `<all_urls>` удалён из `content_scripts.matches`; остались
   только `http://localhost:*/*` и `http://127.0.0.1:*/*`. STT-цель больше не выводится из
   `location.hostname` и сохраняется только для доверенных loopback-источников. Версия
   расширения поднята до `1.0.35` (согласованно в `manifest.json` и `content.js`).
3. **Deployment gap — закрыт.** `sync-plugin.sh` теперь поставляет в bundle не только
   entrypoints, но и `lib/`, `stt-server/`, `shared/`, `doctor.sh` и `fix-mic.sh`, с
   пофайловым `--check`. Launcher, `heal`, `whisper` и `text` научились находить ресурсы
   относительно bundle, а не только относительно `cwd`/исходников.

## Границы проверки

В этом проходе менялись **runtime-код** (`src/lib/shell.ts`, `src/lib/server-launcher.ts`,
`src/lib/heal.ts`, `src/lib/whisper.ts`, `src/lib/text.ts`, `sync-plugin.sh`), конфигурация
расширения (`extension/manifest.json`, `extension/content.js`, `extension/popup.js`), новые
тесты (`test/shell.test.mjs`, `test/deploy.test.mjs`) и документы. `stt_server.py` не менялся.
Непосредственно перед doc-правками реально выполнены:

- `PATH=/tmp/node-v22.23.3-linux-x64/bin:$PATH npm test` — **93/93** (было 76/76; +17 новых
  тестов: 13 на shell boundary, 4 на поставку bundle);
- `python3 -m pytest -q` — **65 passed**, exit `0`;
- `bash sync-plugin.sh --check` — **exit `0`**, все 19 файлов `OK`;
- `npm run typecheck` (underlying `tsc --noEmit`) — **не доверенный/no-op**: в V2 отсутствуют
  local dependencies, а использованный 0-байтовый executable-shim не запускает TypeScript;
- отдельный external-dependency typecheck — **exit `0`**: Node 22 напрямую запустил
  `<V1_PROJECT_ROOT>/node_modules/typescript/bin/tsc` с временным
  external-resolution config `<EXTERNAL_TYPECHECK_CONFIG>` (typeRoots/paths к V1
  dependencies). Это не автономная проверка V2.
- `PATH=/tmp/node-v22.23.3-linux-x64/bin:$PATH npm test` prerequisite: default Node `v18` не подходит для script с
  `--experimental-strip-types`; результат получен на Node `22.23.3`. Поле
  `package.json.engines.node >=20` не отражает фактический prerequisite и требует отдельной
  future code/config task.

Живая проверка нового bundle после рестарта сервиса: плагин `voice` в статусе `active`,
команды `voice` и `v` зарегистрированы, `/voice doctor` выполнился end-to-end и вернул
диагностику. Отдельно проверены живые вызовы `shell.ts` на реальных местах вызова
(`command -v`, `test -x`, `pkill`, `env`, `cat` файла с `;`/`$(x)` в имени) — payload остаётся
одним аргументом.

Примечание про API: запрос `/api/plugin?directory=...` в v2.0.15 игнорирует параметр и
отвечает для каталога сервиса, поэтому отсутствие `voice` в таком ответе не означает, что
плагин не загружен; авторитетны `/api/plugin` без параметра и лог `loading plugin`.

## Skill registry / restart note

Исправленные on-disk skill/agent docs уже отражают V2. Loaded skill payload текущего OpenCode
процесса неавторитетен до restart: registry может вернуть старый V1 payload из tooling/cache.
On-disk files authoritative для следующей загрузки; automatic refresh не обещаем. Это статус
загруженного registry, а не ошибка текущих файлов; service не перезапускаем, а OpenCode/TUI
перезапускаем только там, где это нужно для проверки новой загрузки.

## Матрица статусов

| Область | Статус | Доказательство | Что это означает |
| --- | --- | --- | --- |
| Загрузка server plugin | **Работает** | OpenCode `v2.0.15`; в live-сессии server plugin `voice` активен | V2 loader принимает плагин |
| Регистрация команд | **Работает** | В live-сессии зарегистрированы `voice` и `v` | Обе команды принадлежат плагину |
| V2 entrypoint | **Работает** | `src/index.ts` экспортирует рабочий plain object `{ id, setup(ctx) }`; value-импорт `@opencode/plugin` намеренно отсутствует | Обход V1 loader-конфликта с node_modules успешен |
| Регистрация через transform | **Работает** | `ctx.command.transform(editor => editor.add(...))` в `src/index.ts` и загруженной копии | V2 callback API используется без выдуманного transform ID |
| PTT: запись → микрофон → STT → текст | **Работает** | Живая запись `2026-09-24T21:55:32.539Z`, `source=command`, `dur=9.63s`, непустая русская фраза | Основной голосовой путь реально проходит end-to-end |
| Кнопка Chrome extension | **Работает** | Живая запись `2026-09-24T21:56:38Z`, `source=button`, непустая русская фраза | Второй capture/transcription путь реально работает |
| Версия extension bundle | **Работает** | `extension/manifest.json` содержит `1.0.35`; `extension/content.js` печатает `content.js v1.0.35 loaded` | Manifest и загружаемый bundle согласованы |
| Extension permissions / injection scope | **Работает** (P0 закрыт в этом проходе) | `content_scripts.matches` = только `http://localhost:*/*` и `http://127.0.0.1:*/*`; `<all_urls>` удалён. STT-цель не выводится из `location.hostname` и сохраняется только для loopback (`TRUSTED_STT_HOSTS`) | Effective injection scope сужен до trusted local origins; least-privilege достигнут по content scripts |
| Shell adapter security boundary | **Работает** (P0 закрыт в этом проходе) | `src/lib/shell.ts` не использует `/bin/bash`: значения передаются как argv через `execFile` с `shell:false`; 13 тестов в `test/shell.test.mjs` на shell metacharacters; проверено на живых call-sites | Adapter теперь действительно security boundary |
| STT server health | **Работает** | Live `/health` вернул HTTP 200: `faster-whisper 1.2.1`, модель `small`, устройство CPU | Локальное распознавание доступно |
| Совпадение server.py V1/V2 | **Работает** | `stt_server.py` в V1 и V2 дали одинаковый local verification digest (SHA-256): `524ace60e4f6175b9d9e6f50a2ece72f5cd1de6f4a28d3644994513b02843331` | STT backend не потребовал отдельной V2-логики; digest без source path |
| TUI CLI plugin: загрузка и API | **Частично** | TUI source и loaded copy синхронизированы; sync entrypoints проверен, но чистая V2 TUI/typecheck проверка не зафиксирована, внешняя проверка не автономна; target `@opentui` symlinks указывают на V1 deps `0.4.5`, package.json заявляет `^0.5.12`, а `@opencode/plugin 2.0.15` ожидает peer `>=0.5.10` | TUI load evidence смешанный; physical hotkey отдельно не подтверждён |
| Физический хоткей `<leader>v` | **Не подтверждено** | В логах нет отдельного живого события физического нажатия клавиши | Нельзя утверждать, что именно hardware/keymap event проверен |
| `🎤` в `prompt.footer.status` | **Работает** как индикатор | Код TUI добавляет slot с текстом `🎤`; обработчика клика нет | Это не кликабельная кнопка |
| Семантика результата TUI-команды | **Частично** | V2 `ctx.session.prompt({ sessionID, text, delivery })` отправляет транскрипт в сессию/модели | Текст не вставляется в редактор и model call запускается автоматически |
| Info-сабкоманды | **Частично** | `backend`, `lang`, `device`, `help`, `doctor`, `heal` отвечают; `svc(...)` проходит через `ctx.session.prompt` | Запрос не пустой, но модель всё равно вызывается без необходимости |
| Автозапуск/watchdog именно V2 bundle | **Работает** (P0 закрыт в этом проходе) | `server-launcher.ts` ищет `stt-server/stt_server.py` и относительно bundle (`../stt-server/`), и относительно исходников; `test/deploy.test.mjs` проверяет резолв **внутри** bundle из постороннего temp-cwd | Cwd-dependent deployment gap устранён |
| Самостоятельность V2 bundle | **Работает** (P0 закрыт в этом проходе) | `sync-plugin.sh` поставляет entrypoints, `lib/`, `stt-server/`, `shared/`, `doctor.sh`, `fix-mic.sh`; `bash sync-plugin.sh --check` — exit `0` по всем 19 файлам; `test/deploy.test.mjs` валидирует именно поставленный bundle | Локальная поставка воспроизводима одной проверкой sync |
| Серверный TTS (Piper) | **Не работает** | Health: `tts.enabled=true`, `tts.available=false`; Piper отсутствует | Озвучка ответов требует отдельной установки/настройки |
| Автономный typecheck в checkout | **Частично** | `npm run typecheck` — no-op из-за 0-байтового shim и отсутствия local deps; отдельный Node 22 + V1 `typescript/bin/tsc` + `<EXTERNAL_TYPECHECK_CONFIG>` завершился exit `0` | Внешняя проверка успешна, но не автономна для V2 |
| Node prerequisite для test command | **Частично** | Default Node `v18`; `93/93` только на Node `22.23.3`; `package.json.engines.node >=20` не означает достаточный test prerequisite | Нужна future code/config task, package.json в этом проходе не менялся |
| Полная автономная V2 migration | **Частично** | P0-блокеры (shell boundary, extension scope, deployment gap) закрыты и покрыты тестами; остаются UX-разница, TUI tooling mismatch и автономность typecheck | Ядро и безопасность закрыты; полная автономность требует отдельных task |

## V2 API и точка регистрации

### Server plugin

Источник истины для server plugin — `src/index.ts`. Фактическая загружаемая копия:

```text
<PROJECT_ROOT>/.opencode/plugins/voice/index.ts
```

Entry point намеренно имеет форму working plain object:

```ts
export default {
  id: "voice",
  async setup(ctx) {
    // ...
  },
}
```

В server entrypoint нет value-импорта `@opencode/plugin`. Это важно: такой импорт заставлял
лоадер пытаться собрать проектный `node_modules`. `@opencode/plugin` нужен как зависимость для
типов/CLI-TUI, но не как value-импорт server entrypoint.

Команды регистрируются синхронным callback без отдельного идентификатора transform:

```ts
ctx.command.transform((editor) => {
  editor.add({ name: "voice", description, execute })
  editor.add({ name: "v", description, execute })
})
```

`execute` получает объект invocation с полями:

```text
{ sessionID, prompt, delivery }
```

Параметры команды читаются из `prompt.text`. Выполнения последовательны; тяжёлая запись и
STT выполняются внутри async `execute`, а не в transform callback.

### V1 → V2 mapping

| Область | V1 | Текущее V2 |
| --- | --- | --- |
| Конфигурация plugin | config `plugin` tuple | native `plugins` object: `[{ "package": ..., "options": {} }]` |
| Server export | function export/plugin factory | working plain object `{ id: "voice", setup(ctx) }` |
| Command hook | `command.execute.before` | owned command через `ctx.command.transform(editor => editor.add(...))` |
| Result semantics | `client.tui.appendPrompt` вставлял текст в редактор | `ctx.session.prompt({ sessionID, text, delivery })` отправляет transcript в сессию/модель; UX debt |
| Shell | Bun `$` | `src/lib/shell.ts` (`node:child_process`, `.text()`/`.quiet()`) |
| TUI/web packaging | V1 TUI/web directories | V2 `src/tui.tsx` + package export `./tui` |
| STT server | Python `stt_server.py` | Python `stt_server.py` без V2-изменений; файл V1/V2 совпадает |

Live-конфигурация plugin:

- `~/.config/opencode/opencode.json` — package file URL
  `file://<PROJECT_ROOT>/.opencode/plugins/voice`;
- `<PROJECT_ROOT>/opencode.json` — project-relative package
  `./.opencode/plugins/voice`.

Оба конфигурационных пути подключают один V2 bundle; отдельная `commands.voice` запись не
нужна.

### TUI client

TUI-часть загружается из `.opencode/plugins/voice/tui.tsx` и вызывает серверную команду
через:

```ts
context.client.session.command({
  sessionID,
  name: "voice",
  text: "/voice",
})
```

Историческая one-off headless сверка TUI проходила `14/14`, но не оставила сохранённого
воспроизводимого test artifact/command. TUI source и loaded copy синхронизированы; sync
entrypoints проверен, но чистая V2 TUI/typecheck проверка не зафиксирована, внешняя проверка
не автономна. В target `@opentui` symlinks указывают на V1 deps `0.4.5`, `package.json`
заявляет `^0.5.12`, а `@opencode/plugin 2.0.15` ожидает peer `>=0.5.10`. Поэтому TUI load
evidence смешанный: physical hotkey отдельно не подтверждён. Символ `🎤` в
`prompt.footer.status` — только визуальный индикатор, не кнопка.

## Семантическая разница V1/V2

В V1 `client.tui.appendPrompt` вставлял распознанный текст в редактор. Это позволяло
пользователю сначала увидеть текст и самому отправить его.

В V2 текущий код вызывает:

```ts
ctx.session.prompt({ sessionID, text, delivery })
```

То есть распознанный текст становится следующим user prompt и передаётся модели. Это
подтверждается live-поведением и является **частичной адаптацией UX**, а не полной
эквивалентностью V1:

- запись и распознавание работают;
- текст попадает в сессию/модель автоматически;
- вставки только в редактор нет;
- model call для PTT/file — часть выбранного V2 auto-submit поведения; UX-долг состоит в отличии от V1;
- нежелательный дополнительный model call — именно для info-сабкоманд `svc(...)`.

Поэтому в документации нельзя обещать «текст вставлен в поле» для TUI-команды. Формулировка
должна быть: «транскрипт отправляется в сессию/модели как следующий prompt».

## Source/help debt

В текущем user-facing `/voice help` и в комментариях `src/index.ts` всё ещё встречается
формулировка о том, что текст вставляется в поле ввода: help обещает «текст в поле ввода»,
а верхние комментарии entrypoint — «вставить текст». Код V2 при этом отправляет transcript
через `ctx.session.prompt` и запускает auto-submit. Это отдельный source/help debt:
runtime-файлы в данном проходе не менялись, а документация фиксирует фактическую семантику
и не скрывает оставшееся противоречие.

## Живые доказательства

### PTT-команда

Источник: `/tmp/opencode/voice-recognized.log`, техническая метка времени
`2026-09-24T21:55:32.539Z`:

```text
2026-09-24T21:55:32.539Z source=command backend=faster-whisper model=small lang=ru dur=9.63s text="<REDACTED>"
```

Ненулевая длительность и непустая распознанная русская фраза подтверждают весь путь:
микрофон/PulseAudio → WAV → faster-whisper → текст → V2-сессия.

### Кнопка расширения

Источник: тот же файл, запись `2026-09-24T21:56:38Z`:

```text
2026-09-24T21:56:38Z source=button backend=faster-whisper model=small lang=ru dur=0.00s text="<REDACTED>"
```

Это отдельное live-подтверждение браузерного пути. `source=button` формируется по
`X-Voice-Source` и не подменяет PTT-проверку.

Privacy rationale: raw speech/transcript не публиковать. В evidence оставлены только технические
metadata и `text="<REDACTED>"`; локальный log snapshot с payload не является документационным
материалом.

### STT и doctor

В live-наблюдении `/health` вернул HTTP 200 со следующими параметрами:

- `faster-whisper 1.2.1`;
- модель `small`;
- устройство `cpu`.

`stt_server.py` в V2 (`<PROJECT_ROOT>/stt-server/stt_server.py`) и V1-пути
(`<V1_PROJECT_ROOT>/stt-server/stt_server.py`) совпадают
байт-в-байт. Это снимает отдельный STT migration риск: проблема V2 — не в тексте Python
сервера.

Doctor отдельно подтвердил:

- сервер слушает и отвечает;
- CORS для extension проходит;
- микрофон живой: delivery `0.86x`, peak `318`, RMS `25`.

Это рабочие эксплуатационные показатели для зафиксированной пробы. Единственная проблема,
которую он зафиксировал, — TTS: `enabled=true`, `available=false`, потому что Piper не
установлен. Это не дефект V2-порта.

TTS lifecycle is separate from voice retention: cache eviction is size-based, server purge
skips `tts-*`, and `/tmp/opencode/voice-tts.log` has no automatic retention/rotation. Do not
promise time-based deletion; manual purge/retention policy is required where needed.

### Автотесты и статические проверки

Результаты текущего аудита, выполненные до doc-правок:

- `PATH=/tmp/node-v22.23.3-linux-x64/bin:$PATH npm test`: **93/93**;
- `python3 -m pytest -q`: **65 collected**, exit `0`;
- `bash sync-plugin.sh --check`: **OK**;
- TUI: историческая one-off headless сверка `14/14`, без сохранённого artifact/command;
  чистая V2 TUI проверка не зафиксирована.

Отдельно о TypeScript: `PATH=/tmp/node-v22.23.3-linux-x64/bin:<V1_PROJECT_ROOT>/node_modules/.bin:$PATH npm run typecheck`
(underlying `tsc --noEmit`) в текущем V2 checkout сейчас недоверен и фактически
является no-op: local dependencies отсутствуют, а 0-байтовый executable-shim не запускает
TypeScript. Отдельная проверка с реальным TypeScript
`<V1_PROJECT_ROOT>/node_modules/typescript/bin/tsc`, запущенным напрямую
Node 22 с временным external-resolution config
`<EXTERNAL_TYPECHECK_CONFIG>` (typeRoots/paths к V1 dependencies), завершилась с
exit `0`. Это не автономная проверка V2 checkout.

## Критичный незакрытый deployment gap

На момент проверки процесс STT был запущен так:

```text
python3 -u <V1_PROJECT_ROOT>/stt-server/stt_server.py --port 8765
```

То есть работающий сервер — V1 path, а не V2 path
`<PROJECT_ROOT>/stt-server/stt_server.py`.

В загруженном V2 bundle:

```text
<PROJECT_ROOT>/.opencode/plugins/voice/
```

есть `index.ts`, `tui.tsx`, `package.json` и `lib/`, но нет `stt-server/` и `doctor.sh`.
`server-launcher.ts` проверяет, в частности:

- `OPENCODE_VOICE_SERVER_SCRIPT`;
- путь относительно загруженного модуля;
- старые V1-кандидаты от plugin layout;
- `stt-server/stt_server.py` относительно `process.cwd()`.

При сервисном `cwd=<SERVICE_CWD>` эти кандидаты не находят
`<PROJECT_ROOT>/stt-server/stt_server.py`. Поэтому **autostart/watchdog для V2 local
bundle не автономен**. Нельзя писать в AGENTS или setup-документации, что V2 local bundle уже
автоматически поднимает свой сервер.

Отдельно: `sync-plugin.sh` синхронизирует только `src/index.ts` и `src/tui.tsx`. В текущем
loaded bundle entrypoints и `lib/` копировались/поддерживались вручную, но `stt-server/`,
`doctor.sh`, `fix-mic.sh` и `shared/` не поставлены этим скриптом. Поэтому чистая V2-установка
пока невоспроизводима.

## Controlled autostart evidence

В текущем аудите выполнен controlled launcher smoke test без вмешательства в рабочий порт:

- при `directory=<PROJECT_ROOT>` и `cwd=<PROJECT_ROOT>` на временном порту `8766`
  loaded launcher нашёл `<PROJECT_ROOT>/stt-server/stt_server.py` и запустил его;
- тот же вызов с actual service `cwd=<SERVICE_CWD>` вернул `script not found`/`false`;
- временный процесс был убит, порт `8765` не трогали.

Это доказывает именно cwd-dependent deployment gap: V2 script существует и доступен при
корректном project cwd, но текущий service launcher не автономен из-за `<SERVICE_CWD>`.

## Первичный симптом «пустой запрос»

Симптом проявился после того, как `state.json` содержал `backend=api` без
`OPENAI_API_KEY`. После сброса состояния в `local` и перезапуска Voice заработал. Это
подтверждённая прикладная конфигурация, но не доказательство отдельной проблемы TUI.

Старый TUI-клиент действительно может сохранять прежнее состояние, поэтому stale client —
**вероятная прикладная причина первого неуспеха**, а не установленный факт. После изменений
плагина, TUI или service-конфигурации нужен restart; иначе клиент может продолжать
использовать старое состояние.

## Что нужно сделать дальше

Закрытые P0-блокеры (shell injection, extension scope, deployment gap) вынесены в раздел
«Закрытые P0-блокеры» выше и повторно не перечисляются. Остаются:

1. **P1 — исправить source/help debt в `src/index.ts`.** В строках `83-87` убрать V1-утверждение
   «OpenCode всегда вызывает prompt после execute»; help и комментарии «в поле ввода» заменить
   на V2 auto-submit semantics. Runtime в этом проходе не менять; docs debt не скрывать.
2. **P1 — проверить V2 registration lifecycle.** `src/index.ts:370-382` вызывает
   `ctx.command.transform(...)` без `await` возвращаемого V2 `Promise<Registration>`.
   Live registration работает, но canonical lifecycle/cleanup нужно отдельно проверить и
   исправить в runtime task.
3. **P1 — решить UX-контракт.** Либо реализовать безопасную вставку распознанного текста в
   V2 editor с явным submit, либо оставить auto-submit и закрепить его во всех docs/help
   текстах. До этого называть V2-порт полным UX-портом нельзя.
4. **P1 — убрать нежелательный дополнительный model call для info-сабкоманд.** `backend`, `lang`,
   `device`, `help`, `doctor` и `heal` уже отвечают, но `svc(...)` проходит через
   `ctx.session.prompt`; нужна V2-стратегия показа без ответа модели.
5. **P1 — выровнять TUI tooling и проверить физический `<leader>v`.** Устранить mismatch
   `@opentui` symlinks `0.4.5` / package `^0.5.12` / peer `>=0.5.10`; историческая one-off
   сверка `14/14` без artifact/command не является чистой V2 TUI проверкой. Нужна
   воспроизводимая проверка и запись реального key event.
6. **P2 — довести TTS.** Установить Piper/голоса или явно отключить `OPENCODE_VOICE_TTS`,
   затем повторно проверить `tts.available`.
7. **P2 — сделать typecheck автономным.** Установить локальные зависимости в
   `<PROJECT_ROOT>` и заменить no-op `npm run typecheck` на реальный V2 runner; внешний
   Node 22/V1 TypeScript check с `<EXTERNAL_TYPECHECK_CONFIG>` не считать независимой
   проверкой V2 checkout.
8. **P1 — зафиксировать Node prerequisite.** В отдельной code/config task обновить
   `package.json.engines.node`/CI или test runner так, чтобы Node 22.23.3 явно был prerequisite.
9. **P2 — добавить чистую V2 deployment smoke-проверку.** Она должна стартовать из
   `<PROJECT_ROOT>`, поднимать V2 server path, проверять `/health`, CORS, кнопку и
   отсутствие зависимости от V1 процесса.
10. **P1 — исправить bind source debt.** `extension/content.js:5-6` всё ещё говорит
    `0.0.0.0`, хотя фактический default — `127.0.0.1`. LAN `0.0.0.0` допустим только
    явным решением с token, CORS не является auth, а `/health` остаётся public.
11. **P1 — привести `host_permissions` к валидным Chrome match patterns.** Записи вида
    `172.16.0.0/12` и `192.168.0.0/16` невалидны для `manifest.json`: их нужно либо заменить
    на корректные шаблоны, либо удалить. Это не меняло effective scope content script,
    но оставляет ошибку в манифесте.
12. **P2 — перезагрузить расширение в Chrome.** Версия `1.0.35` со сжатым scope требует
    явного reload расширения в `chrome://extensions`, иначе в браузере останется старая
   `1.0.34` с `<all_urls>`.

## Ограничение качества STT

`small` на CPU — это выбранная эксплуатационная конфигурация. Она работает и обеспечивает
живое распознавание, но качество/скорость ограничены CPU и размером модели. Это ограничение
не является проблемой миграции Voice на V2 и не должно смешиваться с deployment gap.

## Итоговая классификация

- **Работает:** загрузка V2 server plugin, регистрация `voice`/`v`, PTT end-to-end, STT,
  кнопка расширения, live-распознавание.
- **Работает (закрыто в этом проходе):** shell security boundary (`shell.ts` на argv +
  `execFile` без shell), least-privilege scope расширения (`<all_urls>` удалён, версия
  `1.0.35`), поставка V2 bundle (`sync-plugin.sh` + bundle-aware launcher/`heal`/`whisper`/`text`).
- **Частично:** TUI CLI (загрузка/API без отдельного физического hotkey evidence), V2 UX
  auto-submit, info-сабкоманды с нежелательным дополнительным model call,
  registration lifecycle/cleanup debt, автономность typecheck и Node prerequisite для test command.
- **Не работает:** серверный Piper TTS (`tts.available=false`).
- **Не подтверждено:** физическое нажатие `<leader>v`.

Подробный текущий тестовый план находится в [`TEST_PLAN.md`](TEST_PLAN.md).
