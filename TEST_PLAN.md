# План тестирования OpenCode Voice V2

> OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice2

**Корень всех команд:** `<PROJECT_ROOT>`  
**Проверенная среда:** OpenCode `v2.0.15`  
**Связанный отчёт:** [`V2_MIGRATION.md`](V2_MIGRATION.md)

В текущем V2 TUI `/voice` не только распознаёт речь, но и **отправляет транскрипт в сессию как
следующий user prompt**. Это auto-submit с запуском модели, а не вставка текста в редактор.
Кнопка браузерного расширения — отдельный путь: она вставляет текст в поле Web UI.

## 0. Быстрая статическая и герметичная проверка

Запускать из корня V2 checkout:

```bash
cd <PROJECT_ROOT>
bash sync-plugin.sh --check
PATH=/tmp/node-v22.23.3-linux-x64/bin:$PATH npm test                 # текущий аудит: 145/145
python3 -m pytest        # текущий аудит: 75 passed, exit 0
```

`sync-plugin.sh --check` проверяет соответствие всех 20 поставляемых файлов:

- `src/index.ts` → `.opencode/plugins/voice/index.ts`;
- `src/tui.tsx` → `.opencode/plugins/voice/tui.tsx`;
- `src/lib/*.ts` → `.opencode/plugins/voice/lib/*.ts`;
- `stt-server/` → `.opencode/plugins/voice/stt-server/`;
- `shared/` → `.opencode/plugins/voice/shared/`;
- `doctor.sh`, `fix-mic.sh` → `.opencode/plugins/voice/`.

При расхождении печатается `FAIL` и скрипт завершается exit `1`. Поставка теперь включает
`lib/` и server resources, поэтому ручное копирование больше не требуется. Раньше `stt-server/`, `doctor.sh`,
`fix-mic.sh` и `shared/` не поставлены. Отсутствие server resources — отдельный deployment
smoke-check (раздел 9).

`pytest` hermetic: не требует микрофона и загруженной модели. Node E2E использует заглушки;
серверный E2E пропускается без Flask и запускается в server job.

### TypeScript caveat

В checkout нет локального `node_modules/.bin/tsc`.
`PATH=/tmp/node-v22.23.3-linux-x64/bin:<V1_PROJECT_ROOT>/node_modules/.bin:$PATH npm run typecheck`
(underlying `tsc --noEmit`) сейчас недоверен и фактически no-op: local dependencies отсутствуют,
а 0-байтовый executable-shim не запускает TypeScript. Отдельная внешняя проверка реально запускала Node 22 с
`<V1_PROJECT_ROOT>/node_modules/typescript/bin/tsc` и временным
external-resolution config `<EXTERNAL_TYPECHECK_CONFIG>` (typeRoots/paths к V1
dependencies), завершилась exit `0`. Это не автономная проверка V2; в CI нужно установить
local dependencies и заменить no-op runner.

Node prerequisite для test command: default Node `v18` не поддерживает фактический
`node --experimental-strip-types` path; `93/93` получен на Node `22.23.3`. Поле
`package.json.engines.node >=20` не отражает достаточный prerequisite и остаётся future
code/config task.

### Workflow check (если target содержит workflows)

```bash
if [[ -d <PROJECT_ROOT>/.github/workflows ]]; then
  bash check-workflows.sh
else
  echo 'SKIP (no workflows in target)'
fi
```

В standalone `openvi2` без `.github/workflows` это **SKIP**, а не PASS: пустой
`check-workflows.sh` не является проверкой CI YAML.

Skill/agent docs на диске исправлены, но loaded skill payload текущего OpenCode процесса
неавторитетен до restart и может вернуть старый V1 payload из tooling/cache. On-disk files
authoritative для следующей загрузки; automatic refresh не обещаем. Это tooling/cache status,
а не ошибка текущих файлов; service не перезапускать.

## 1. V2 smoke: загрузка и команды

1. Запустить `opencode` из `<PROJECT_ROOT>` на версии `v2.0.15`.
2. Убедиться, что server plugin `voice` активен, а в списке команд есть `voice` и `v`.
3. Проверить entrypoint `src/index.ts` и loaded `.opencode/plugins/voice/index.ts`:
   - default export — plain object `{ id, setup(ctx) }`;
   - нет value-импорта `@opencode/plugin` в server entrypoint;
   - используется `ctx.command.transform(editor => editor.add(...))` без transform ID.
4. Проверить форму invocation: `{ sessionID, prompt, delivery }`.
5. После изменения plugin/TUI перезапустить OpenCode и TUI-клиент; старый клиент может
   сохранять прежнее состояние.

Ожидаемый статус: core загрузка и регистрация команд — **работает**. Это smoke не
проверяет deployment server path; см. раздел 9.

## 2. PTT: реальный микрофон и реальный auto-submit

### Предусловия

- `OPENCODE_VOICE_BACKEND=local`;
- `OPENCODE_VOICE_LANGUAGE=ru`;
- `OPENCODE_VOICE_MODEL` не использовать для local STT: это OpenAI API-only; local checks
  используют `WHISPER_MODEL`/`WHISPER_CPP_MODEL_SIZE` и related local paths;
- на текущем CPU доступен `faster-whisper` с моделью `small`;
- в WSL2 доступен PulseAudio (`PULSE_SERVER=unix:/mnt/wslg/PulseServer`).

### Процедура

1. Запустить `opencode` из `<PROJECT_ROOT>`.
2. Ввести `/voice` (или проверить алиас `/v`).
3. Говорить; дождаться auto-stop после тишины.
4. Наблюдать не только лог, но и ответ модели: V2 должен отправить распознанный текст в
   сессию и запустить следующий model call.

### Что считать успехом

- в `/tmp/opencode/voice-recognized.log` появляется непустая строка `source=command`;
- для живого smoke зафиксирована строка
  `2026-09-24T21:55:32.539Z source=command ... dur=9.63s text="<REDACTED>"`;
- transcript отправлен в сессию/модель, а не вставлен только в редактор;
- нет фатального `empty prompt`/необработанного plugin error;
- последующий ответ модели соответствует распознанному тексту.

Не обещать toast или вставку в поле для TUI-команды. Текущий V2 UX — auto-submit; это
частичная адаптация относительно V1-редактора.

### Диагностика

```bash
bash doctor.sh
```

В зафиксированной live-пробе server, CORS и mic исправны: delivery `0.86x`, peak `318`,
RMS `25`. Эти числа — evidence конкретной пробы, а не универсальный порог качества.

## 3. TUI CLI plugin

TUI source и loaded copy:

```text
src/tui.tsx
.opencode/plugins/voice/tui.tsx
```

Историческая one-off headless сверка проходила `14/14`, но не оставила сохранённого
воспроизводимого test artifact/command. TUI source и loaded copy синхронизированы; sync
entrypoints проверен, но чистая V2 TUI/typecheck проверка не зафиксирована, внешняя проверка
не автономна. В target `@opentui` symlinks указывают на V1 deps `0.4.5`, `package.json`
заявляет `^0.5.12`, а `@opencode/plugin 2.0.15` ожидает peer `>=0.5.10` — TUI load evidence
смешанный.

Отдельно выполнить ручную проверку:

1. Открыть активную session route.
2. Нажать `<leader>v`.
3. Убедиться, что событие дошло до `session.command({ sessionID, name: "voice", text: "/voice" })`.
4. Сохранить live-лог/key event.

Статус на текущем срезе: историческая one-off сверка есть, чистая V2 TUI проверка не
зафиксирована; физический hotkey не подтверждён отдельным live-наблюдением. `🎤` в
`prompt.footer.status` — только индикатор, не кнопка.

## 4. Файлы и info-сабкоманды

### Файл

```bash
# Подготовить отдельный короткий wav вне репозитория, затем в TUI:
/voice /tmp/voice_test.wav
```

Ожидаемый результат: файл распознан и отправлен в сессию/модель. Проверить
`source=command-file` и отсутствие fabricated/empty transcript для непустого файла.

### Info-сабкоманды

```text
/voice backend
/voice backend local
/voice lang
/voice lang ru
/voice device
/voice device cpu
/voice help
/voice doctor
/voice heal
```

Ожидается, что команды меняют/показывают состояние и возвращают полезный результат. В
V2 info-сообщение проходит через `ctx.session.prompt`, поэтому модель может ответить даже
на служебный текст. В live `/voice backend` получен ответ «Принято.» — это не пустой запрос,
но нежелательный дополнительный model call именно для info-сабкоманды; зафиксировать как
долг, а не как успешную оптимизацию.

Проверить `OPENCODE_VOICE_STATE_FILE`. Если state был загрязнён `backend=api` без
`OPENAI_API_KEY`, сбросить его в `local`, затем перезапустить OpenCode. Старый TUI-клиент
может сохранять прежнее состояние; это вероятная прикладная причина раннего «пустого
запроса», но не отдельный доказанный дефект.

## 5. Кнопка Chrome extension

Текущая версия bundle: **1.0.34**.

1. В `chrome://extensions` загрузить/перезагрузить `<PROJECT_ROOT>/extension`.
2. Открыть OpenCode Web UI.
3. Нажать 🎤, сказать фразу, остановить запись.
4. Проверить, что текст вставлен в поле Web UI (это отдельный browser path, не TUI
   auto-submit).

Подтверждённое live evidence:

```text
2026-09-24T21:56:38Z source=button ... text="<REDACTED>"
```

Ожидается также:

- `extension/manifest.json` version = `1.0.35`;
- `extension/content.js` содержит `content.js v1.0.35 loaded`;
- сервер доступен по `127.0.0.1:8765` в локальном сценарии;
- `content_scripts.matches` содержит только `http://localhost:*/*` и `http://127.0.0.1:*/*`:
  `<all_urls>` удалён, effective scope extension — least-privilege. Отдельно проверить, что
  в Chrome выполнен reload расширения (иначе в браузере останется старая `1.0.34`);
- CORS preflight разрешает `X-Voice-Source` и, при включённом token, `X-Voice-Token`.

Диагностика из корня:

```bash
bash doctor.sh
curl -s http://127.0.0.1:8765/health
```

Если задан `OPENCODE_VOICE_TOKEN`, значение в popup должно совпадать с серверным; секреты и
токены в этот документ не записываются.

## 6. STT server, auth и ограничения

Проверить live `/health` (ожидается HTTP 200):

- `faster-whisper 1.2.1`;
- `model=small`;
- `device=cpu`.

`stt_server.py` в V2 и V1 path должен совпадать байт-в-байт. В текущем live-окружении
совпадение подтверждено одинаковым SHA-256.

Проверить безопасность без публикации токена:

- default bind — `127.0.0.1`;
- `/health` не требует token;
- остальные endpoints требуют token, если `OPENCODE_VOICE_TOKEN` задан;
- чужой `Origin` не получает разрешающий CORS.

`small` на CPU — операционное ограничение качества/скорости. Оно не является V2 migration
issue.

## 6.1 Retention и lifecycle

`OPENCODE_VOICE_RETAIN_SECONDS<=0` отключает scheduled cleanup, а не удаляет файл сразу;
нужен manual purge. TTS cache eviction выполняется по размеру, server purge пропускает
`tts-*`, а `voice-tts.log` не имеет автоматической retention/rotation policy. Не обещать
time-based deletion.

## 7. TTS (отдельный статус)

Текущий результат — **не работает** для server TTS:

```text
tts.enabled=true
tts.available=false
Piper отсутствует
```

Это не связано с загрузкой V2 plugin или PTT. Для закрытия: установить Piper/голоса или
явно отключить `OPENCODE_VOICE_TTS`, затем повторить `/health`. Browser TTS и STT не следует
смешивать с этим optional-блокером.

## 8. После изменений

После изменения runtime-файлов:

```bash
cd <PROJECT_ROOT>
bash sync-plugin.sh
bash sync-plugin.sh --check
```

Затем перезапустить OpenCode, server и TUI-клиент. Проверить:

- [ ] plugin `voice` active, OpenCode `v2.0.15`;
- [ ] команды `voice` и `v` видны;
- [ ] `/voice` записывает и отправляет transcript в сессию/модель;
- [ ] extension version соответствует `1.0.35` (и расширение перезагружено в Chrome);
- [ ] `bash sync-plugin.sh --check` печатает `OK` по всем 20 файлам;
- [ ] фактический `stt_server.py` запущен из V2 path, а не из V1 path.

## 9. Deployment smoke (cwd-независимость, P0 закрыт)

Cwd-dependent deployment gap закрыт и закреплён тестом `test/deploy.test.mjs`, который
проверяет **поставленный** bundle из постороннего temp-cwd:

- [ ] `serverScript()` находит `stt_server.py` внутри `.opencode/plugins/voice/`;
- [ ] `doctorScript()` находит `doctor.sh` внутри bundle;
- [ ] `loadSpec()` в `whisper.ts`/`text.ts` читает `shared/stt-spec.json` из bundle;
- [ ] Python `parents[1]/shared` совпадает с TS-путём `../shared`.

Остаточная (непокрытая smoke) часть: фактический путь **живого** процесса на сервисном
`cwd=<SERVICE_CWD>` стоит проверить отдельно, запустив сервис и сверив `ps` с bundle path.

### Controlled autostart evidence

В текущем аудите loaded launcher проверялся без вмешательства в рабочий сервис:

- `directory=<PROJECT_ROOT>`, `cwd=<PROJECT_ROOT>`, временный port `8766` →
  найден `<PROJECT_ROOT>/stt-server/stt_server.py`, процесс запущен;
- тот же вызов с actual service `cwd=<SERVICE_CWD>` → `script not found`/`false`;
- временный процесс остановлен, `8765` не затронут.

Это доказывает cwd-dependent gap, а не отсутствие V2 server file: launcher работает при
project cwd и не находит тот же target при service cwd.

Поэтому пункт «V2 autostart/watchdog» сейчас имеет статус **не работает/не завершено**.
Плановый порядок исправления:

1. добавить bundle-relative или явное `OPENCODE_VOICE_SERVER_SCRIPT` resolution;
2. включить `stt-server/`, `doctor.sh`, `fix-mic.sh`, `shared/` и requirements в поставку;
3. проверить запуск с `cwd=<SERVICE_CWD>` и фактический process path;
4. проверить watchdog, `/health`, CORS и button после перезапуска;
5. только после этого объявлять V2 local bundle автономным.

## 10. Skills и agents

В `.opencode/skills/` сейчас 11 навыков: `ovi-overview`, `ovi-plugin`, `ovi-server`,
`ovi-extension`, `ovi-models`, `ovi-audio`, `ovi-debug`, `ovi-dev`, `ovi-security`,
`ovi-tts`, `ovi-setup`. Подключение V2 описано в [`SKILLS_GUIDE.md`](SKILLS_GUIDE.md).

Локальные агенты находятся в `.opencode/agents/`. `@voice-stt` — optional/local helper и не
входит в обязательный pipeline verifier/reviewer/security. Перед изменениями в областях
загружаются соответствующие skills; этот проход менял только документацию.

## Итоговый чек-лист миграции

- [x] OpenCode `v2.0.15`, server plugin и `voice`/`v` зарегистрированы.
- [x] Plain-object entrypoint и `ctx.command.transform` подтверждены.
- [x] PTT end-to-end и кнопка extension подтверждены live-логами.
- [x] STT health/CORS/mic подтверждены; TTS Piper отсутствует.
- [x] `PATH=/tmp/node-v22.23.3-linux-x64/bin:$PATH npm test` 93/93, `pytest` 65 passed/exit 0, sync check OK (текущий аудит).
- [ ] Project-local `npm run typecheck` заменён с no-op на реальный V2 runner.
- [ ] Node `22.23.3` prerequisite для test command отражён в CI/package policy.
- [ ] TUI auto-submit полностью заменён/осознанно принят как UX.
- [x] V2 server path и resources поставляются вместе с plugin (`sync-plugin.sh` + deploy-тест).
- [ ] Живой процесс STT проверен с реальным service cwd.
- [ ] Физический `<leader>v` подтверждён отдельным live key event.
- [x] `content_scripts.matches` не содержит `<all_urls>`; extension permissions review закрыт.
- [ ] `host_permissions` приведены к валидным Chrome match patterns (текущие `172.16.0.0/12`
      и `192.168.0.0/16` невалидны).
- [ ] Расширение перезагружено в Chrome, чтобы новая `1.0.35` со сжатым scope реально применилась.
