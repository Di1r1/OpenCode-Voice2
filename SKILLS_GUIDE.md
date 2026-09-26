# Навыки (skills) в OpenCode Voice V2: подключение и эксплуатация

> OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice2

> **Версия документа:** V2 notes · **Дата среза:** 2026-09-25  
> **Корень проекта:** `<PROJECT_ROOT>`  
> **Область:** `.opencode/skills/`, `AGENTS.md`, нативная V2-конфигурация OpenCode

## 0. Коротко

В текущем checkout навыки лежат прямо в проекте:

```text
<PROJECT_ROOT>/.opencode/skills/
```

OpenCode V2 подключает дополнительные каталоги через нативный массив `skills` в
конфигурации. Абсолютный путь ниже — текущий project choice для cwd `<SERVICE_CWD>`, а не API
requirement: V2 также поддерживает relative paths, `~/` и URLs; массивы объединяются, а
relative path разрешается от active cwd.

```jsonc
// текущий project choice для cwd <SERVICE_CWD>
{
  "skills": [
    "<PROJECT_ROOT>/.opencode/skills"
  ]
}
```

Текущий global config явно регистрирует project path, поэтому этот explicit source имеет
higher precedence than project auto-discovery. После добавления/удаления каталога skills
перезапустите OpenCode; loaded registry не обещает automatic refresh. Loaded skill payload
текущего процесса неавторитетен до restart, а on-disk files authoritative для следующей
загрузки.

## 1. Текущие навыки

В проекте сейчас **11** `ovi-*` skills:

| Skill | Назначение |
| --- | --- |
| `ovi-overview` | обзор Voice, компоненты и поток аудио/текста |
| `ovi-plugin` | V2 entrypoint, команды, recorder, STT и launcher |
| `ovi-server` | `stt_server.py`, endpoints, token, CORS и логи |
| `ovi-extension` | Chrome extension, кнопка, popup, bundle и CORS |
| `ovi-models` | faster-whisper/whisper.cpp, модели, CPU/GPU и качество |
| `ovi-audio` | PulseAudio, `audin`, silence gate, форматы и repair |
| `ovi-debug` | `Failed to fetch`, 401/409, тишина, медленный канал и doctor |
| `ovi-dev` | typecheck, тесты, sync, release и документация |
| `ovi-security` | bind, CORS, token, retention и гигиена секретов |
| `ovi-tts` | browser/server TTS, Piper, `/speak`, voices и popup |
| `ovi-setup` | установка зависимостей, конфигурация и onboarding |

Точный источник истины для каждого skill — соответствующий
`.opencode/skills/<name>/SKILL.md`. Таблица маршрутизации задач находится в
[`AGENTS.md`](AGENTS.md).

## 2. Как это устроено

| Priority | Source | Exact order/path behavior |
| --- | --- | --- |
| 1 | Built-in skills | Skills supplied by OpenCode |
| 2 | Global `.claude/skills` | Global first; then farthest ancestor → current directory |
| 3 | `.agents/skills` | Same ancestor → current ordering as `.claude/skills` |
| 4 | `~/.config/opencode/skills` | Global OpenCode skills directory |
| 5 | Project `.opencode/skills` | Project root → current directory |
| 6 | Explicit `skills` config entries | Config priority, then array order |

Later source wins by ID. В текущем global config `<PROJECT_ROOT>/.opencode/skills`
зарегистрирован explicit entry, поэтому он имеет higher precedence than project auto-discovery.
Не рассчитывайте на silent skip дубликата: одинаковый ID может быть переопределён более поздним
источником.

Минимальная регистрация нового skill:

1. Создать `<PROJECT_ROOT>/.opencode/skills/ovi-<область>/SKILL.md`.
2. Добавить корректный frontmatter `name` и `description`.
3. Добавить путь к `.opencode/skills` в нативный массив `skills`, если каталог не виден из
   корня проекта.
4. Перезапустить OpenCode.
5. Проверить, что skill появился в списке и загружается штатным инструментом `skill`.
6. Добавить строку маршрутизации в `AGENTS.md`.

При вызове V2 skill используйте path-derived ID, например
`skill({ id: "ovi-plugin" })`. Frontmatter `name` — display label, а V2 skill ID определяется
путём `<source>/<name>/SKILL.md`; это не API с параметром `name`. Если cwd запускается вне
project root, нужен global/additional path, хотя project auto-discovery также возможен из корня.

## 3. Формат skill

```markdown
---
name: ovi-example
description: Использовать когда ... — <файлы, симптомы, ключевые слова>.
---

# Название области

Краткое назначение и границы.

## Обязательный порядок

1. ...
2. ...
3. Проверка.
```

Требования к skill ID и frontmatter:

- V2 skill ID всегда path-derived: `<source>/<name>/SKILL.md` (case-sensitive path);
- frontmatter `name` — display label/default, а не источник ID;
- `name == directory` — house convention этого проекта для переносимости, не V2 prerequisite;
- `description` должен описывать **когда** применять skill, а не только его название.

Большие справочные материалы лучше выносить в `references/`; secrets, токены и реальные
значения ключей в skill не помещать.

## 4. Подключение нового skill

```bash
cd <PROJECT_ROOT>
mkdir -p .opencode/skills/ovi-<область>
$EDITOR .opencode/skills/ovi-<область>/SKILL.md
```

В глобальной или иной конфигурации OpenCode путь добавляется в массив:

```jsonc
{
  "skills": [
    "<PROJECT_ROOT>/.opencode/skills"
  ]
}
```

Не создавать отдельную V1-команду `/voice` в конфиге: server plugin регистрирует `voice` и
`v` сам через V2 command transform. Не создавать `commands.voice` без отдельного
архитектурного решения.

После добавления:

```text
перезапустить OpenCode → открыть skill через штатный skill → проверить описание и пути
```

## 5. Гарантия загрузки

Автоматической загрузки каждого skill нет. Надёжные уровни:

1. таблица `Skill routing` в `AGENTS.md`;
2. явное указание в инструкции subagent;
3. прямой вызов `skill({ id: "ovi-plugin" })` владельцем или verifier (для другого skill —
   его path-derived ID).

Если skill не найден, проверяйте по порядку:

| Симптом | Проверка |
| --- | --- |
| skill отсутствует | Проверить exact `<source>/<name>/SKILL.md` form/location, case-sensitive path-derived ID и source order; absolute path — только если он реально нужен для cwd |
| skill не появился после добавления | Перезапустить OpenCode; проверить, что более поздний source не переопределяет ID |
| `name` не совпадает с directory | Не считать mismatch V2 blocker: `name` — display label, ID path-derived; равенство — house convention |
| описание/autoinvoke/permission не срабатывает | Проверить `description`, условия автозагрузки и permission/tooling policy |
| skill найден в `skill`, но не в стороннем plugin registry | Ожидаемо: используется штатный `skill`; учитывать ordered source precedence |

## 6. Текущие paths и версия проекта

Все project-root команды в этом документе начинаются с:

```bash
cd <PROJECT_ROOT>
```

Актуальные V2 paths:

```text
server source:  <PROJECT_ROOT>/src/index.ts
loaded server:  <PROJECT_ROOT>/.opencode/plugins/voice/index.ts
TUI source:     <PROJECT_ROOT>/src/tui.tsx
loaded TUI:     <PROJECT_ROOT>/.opencode/plugins/voice/tui.tsx
STT server:     <PROJECT_ROOT>/stt-server/stt_server.py
extension:      <PROJECT_ROOT>/extension/
```

`opencode.json` подключает plugin package из `.opencode/plugins/voice`; `/voice` и `/v`
регистрируются plugin-кодом. Plugin/TUI config-time изменения требуют restart.

## 7. Версионирование и `.gitignore`

Не делать вывод о local-only только по старому V1-описанию `.gitignore`. Текущий
`<PROJECT_ROOT>/.gitignore` не содержит широкого правила
`.opencode/*`, а `<PROJECT_ROOT>/.opencode/.gitignore` не перечисляет skills в ignored
паттернах. Поэтому этот guide **не утверждает**, что `.opencode/skills/` игнорируются или
автоматически local-only.

Фактическое состояние tracking проверяется в конкретном checkout:

```bash
cd <PROJECT_ROOT>
git check-ignore -v .opencode/skills/ovi-overview/SKILL.md || true
git status --short .opencode/skills
```

Если команда не доступна из-за отсутствия git metadata, это не доказывает ignore; нужно
проверить конкретный репозиторий и его `.gitignore`.

## 8. Безопасность

- Не помещать `OPENAI_API_KEY`, `OPENCODE_VOICE_TOKEN` или значения токенов в skills.
- В примерах использовать только placeholders (`<TOKEN>`, `<ABS_PATH>`).
- Не публиковать содержимое распознанных логов без необходимости.
- Записи и временные WAV держать в RAM (`/dev/shm/opencode-voice`) и учитывать retention.
- Не публиковать raw transcript payload: `voice-recognized.log` может содержать полный текст,
  server log — excerpts, request log — metadata, TTS log/cache — plaintext/cache data.
  Использовать private/protected directories и `0600` where feasible, настроить rotation/retention
  или manual purge осознанно, redact перед sharing; не обещать уже настроенную rotation.
- TTS cache eviction выполняется по размеру; purge пропускает `tts-*`; `voice-tts.log` не имеет
  автоматической retention/rotation policy.
- Перед внешним распространением проверять, что docs не содержат секреты или личные пути.

## 9. Чек-лист подключения

- [ ] Каталог `.opencode/skills/ovi-<область>/` создан.
- [ ] Frontmatter `name` присутствует и используется как display label; directory/path-derived
      ID проверен. Равенство `name == directory` — house convention, не prerequisite.
- [ ] `description` содержит область, файлы и триггеры; autoinvoke/permission проверены.
- [ ] Source location/order и native `skills` entries проверены; более поздний source не
      переопределяет нужный ID непреднамеренно.
- [ ] OpenCode перезапущен; skill загружается штатным инструментом `skill`.
- [ ] Строка добавлена в таблицу маршрутизации `AGENTS.md`.
- [ ] В skill нет секретов и неподтверждённых успешных проверок.

## 10. Связанные документы

- [`AGENTS.md`](AGENTS.md) — архитектура, V2 semantics и routing.
- [`V2_MIGRATION.md`](V2_MIGRATION.md) — evidence, матрица статусов и remaining tasks.
- [`TEST_PLAN.md`](TEST_PLAN.md) — smoke и ручные проверки.
- `extension/README.md` — установка extension и сервера.

## Приложение A. Шаблон

```markdown
---
name: ovi-example
description: Использовать когда правится <область> — <пути и симптомы>.
---

# <Название>

<Назначение и ограничения.>

## 1. Источник истины

| Что | Путь |
| --- | --- |
| runtime | `<path>` |
| loaded copy | `<path>` |

## 2. Проверяемый порядок

1. Загрузить этот skill.
2. Прочитать исходник и loaded copy.
3. Выполнить только разрешённую проверку.
4. Зафиксировать evidence и ограничения.

## 3. Частые ошибки

- <ошибка> → <исправление>
```

## Приложение B. Строка маршрутизации

```markdown
| Plugin internals: `src/index.ts`, `/voice` subcommands, recorder | `ovi-plugin` |
| <Task / area> | `ovi-<область>` |
```
