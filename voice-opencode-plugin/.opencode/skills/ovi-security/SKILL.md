---
name: ovi-security
description: "Использовать при вопросах безопасности и приватности OpenCode Voice V2 — токен доступа, CORS-allowlist, bind на 127.0.0.1, что остаётся в записях и логах, ретеншен/ОЗУ, гигиена секретов в публичном репозитории, права расширения. Ключевые слова: токен, X-Voice-Token, CORS, host, 0.0.0.0, приватность, секреты, публичный репо, retention, KEEP_AUDIO."
license: MIT
compatibility: opencode
metadata:
  author: Di1r1
---

# Безопасность и приватность

Проект публичный, а сервер умеет писать с микрофона и отдавать расшифровки — поэтому границы доступа и утечки через логи/записи важны не меньше функциональности.

## 1. Что где защищает (источник истины)

| Механизм | Где | Поведение |
|---|---|---|
| Bind только localhost | `stt_server.py` (`OPENCODE_VOICE_HOST`, `--host`) | по умолчанию `127.0.0.1`; наружу — только осознанно |
| CORS-allowlist | `stt_server.py` (`_ALLOWED_ORIGIN`, `_cors`) | `localhost`/`127.0.0.1`/RFC1918 + `chrome-extension://[a-p]{32}`; не `*` |
| Токен доступа | `_auth_token`, `_check_token`; расширение (popup) | `OPENCODE_VOICE_TOKEN`; все эндпоинты кроме `/health` и preflight требуют `X-Voice-Token` (или `Authorization: Bearer`) |
| Записи в ОЗУ + ретеншен | `recorder.ts`, `stt_server.py` | `/dev/shm/opencode-voice`; scheduled cleanup через `OPENCODE_VOICE_RETAIN_SECONDS` (300 с), но `<=0` отключает cleanup и требует manual deletion; `OPENCODE_VOICE_KEEP_AUDIO` отключает |
| Логи с текстом | `/tmp/opencode/voice-recognized.log` | каждый распознанный текст + `source=`; чистить перед отправкой наружу |
| Права расширения | `extension/manifest.json` | `content_scripts.matches` и `host_permissions` = только `http://localhost:*/*` + `http://127.0.0.1:*/*`, `<all_urls>` удалён; STT-цель не выводится из `location.hostname`. Прежний дефект с CIDR-подсетями в `host_permissions` (невалидные match patterns, которые Chrome и Web Store не понимали) **исправлен** — сейчас оба списка идентичны и содержат только localhost-паттерны |

TTS lifecycle: cache eviction is size-based, not time-based; server purge skips `tts-*` entries;
`/tmp/opencode/voice-tts.log` has no retention/rotation policy. Treat cache and TTS log as
manual-purge data, not as guaranteed time-based deletion.

### Plaintext risks and sharing

- `/tmp/opencode/voice-recognized.log` can contain full transcripts.
- `/tmp/opencode/stt_server.log` can contain transcript excerpts and runtime diagnostics.
- `/tmp/opencode/voice-requests.log` contains request metadata such as origin/user-agent.
- `/tmp/opencode/voice-tts.log` and TTS cache files contain plaintext/error/cache data.

Keep these paths in a private/protected directory where possible, use mode `0600` where
feasible, and apply rotation/retention/manual purge deliberately. Redact transcripts, paths,
headers and payloads before sharing. Do not claim rotation or retention is already configured.

## 2. Правила проекта

1. **Никаких секретов в репозитории.** В глобальном `~/.config/opencode/opencode.json` лежит Google API-ключ — никогда не копировать его в репо, навыки, логи и коммиты.
2. **Не логировать чувствительное.** Логи и записи содержат речь; перед публикацией (issue, PR, чат) вырезать текст и пути.
3. **Не выставлять сервер наружу без токена.** `OPENCODE_VOICE_HOST=0.0.0.0` без `OPENCODE_VOICE_TOKEN` = любой в сети пишет с микрофона и читает расшифровки.
4. **Extension data-scope (P0 закрыто, v1.0.35).** `host_permissions` и `content_scripts.matches`
   остаются разными поверхностями, но `<all_urls>` удалён: `matches` = только
   `http://localhost:*/*` и `http://127.0.0.1:*/*`. STT-цель больше не выводится из
   `location.hostname` — `sttHost` сохраняется только для `TRUSTED_STT_HOSTS`, а `popup.js`
   пропускает через `trustedSttHost()` лишь loopback. При расширении `matches` обязателен
   повторный manifest/store review; токен хранится в `chrome.storage.local`, не в коде.
   Прежний остаточный дефект с CIDR-подсетями в `host_permissions` исправлен: сейчас
   `host_permissions` = `http://localhost:*/*` и `http://127.0.0.1:*/*`.
5. **Файлы больше не нужны — lifecycle/manual purge.** Записи и `*.webm` в `/dev/shm` и `/tmp/opencode`
   могут требовать manual purge; `OPENCODE_VOICE_RETAIN_SECONDS<=0` отключает scheduled cleanup.
6. **Shell injection (P0 закрыто).** `src/lib/shell.ts` не использует `/bin/bash`: значения
   идут как argv через `execFile` с `shell:false`, поэтому `/voice <file>`, STT model/file
   paths и recorder cleanup больше не позволяют инъекцию. Проверено 13 тестами в
   `test/shell.test.mjs` (metacharacters остаются одним аргументом). Регресс-правило: любая
   новая правка adapter обязана сохранять `shell:false`; встроенные `command -v`/`test -x`
   реализованы нативно, их нельзя заменять вызовом `/bin/bash`.

## 3. Проверки

```bash
# слушает только localhost?
ss -ltn | grep 8765

# preflight: разрешён ли наш заголовок
curl -s -X OPTIONS http://127.0.0.1:8765/beep \
  -H 'Origin: chrome-extension://abcdefghijklmnopabcdefghijklmnop' \
  -H 'Access-Control-Request-Headers: x-voice-token,x-voice-source' -D - -o /dev/null | grep -i allow-headers

# токен реально требуется?
OPENCODE_VOICE_TOKEN="$TOKEN" python3 stt-server/stt_server.py --port 8765 &
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8765/record/status     # 401
curl -s -o /dev/null -w '%{http_code}\n' -H "X-Voice-Token: $TOKEN" \
     http://127.0.0.1:8765/record/status                                          # 200

# нет ли секретов в файлах (для git checkout — git grep; для openvi2 — обычный grep)
grep -RInE 'api[_-]?key|secret|password|sk-[a-z0-9]{10}|BEGIN [A-Z ]*PRIVATE KEY' \
  --exclude='package-lock.json' --exclude-dir='.git' .
```

## 4. Частые ошибки

- Проверять CORS «в браузере» и забывать, что preflight кэшируется: после правки allow-headers **перезапустите сервер** (иначе кнопка `Failed to fetch`, см. `ovi-debug`).
- Считать, что `vibeguard`/маскировка защищает git — она маскирует только вывод инструментов.
- Оставлять `OPENCODE_VOICE_KEEP_AUDIO` включённым в бою (записи накапливаются).
- Копировать реальные логи с речью в issue/PR.

## 5. Чек-лист

- [ ] `ss -ltn` → `127.0.0.1:8765` (если не нужен LAN)
- [ ] токен задан, если сервер доступен не только с localhost
- [x] `content_scripts.matches` не содержит `<all_urls>` (только localhost/127.0.0.1);
      effective scope extension соответствует intentional host permissions
- [ ] `host_permissions` приведены к валидным Chrome match patterns
- [ ] расширение перезагружено в Chrome (иначе активна старая `1.0.34` со `<all_urls>`)
- [ ] preflight разрешает `X-Voice-Token`/`X-Voice-Source`
- [ ] ретеншен записей включён (`OPENCODE_VOICE_KEEP_AUDIO` не задан)
- [ ] в коммитах/доках/навыках нет секретов и реальных путей/логов с речью
