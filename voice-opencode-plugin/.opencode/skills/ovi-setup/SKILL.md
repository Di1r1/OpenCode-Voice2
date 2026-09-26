---
name: ovi-setup
description: "Use when installing or onboarding OpenCode Voice V2 on a (new) machine — setup.sh flags including --all, env.sh persistence, --write-config, extension sideload, first-run checks. Keywords: setup.sh, установка, env.sh, Load unpacked, --all, --tts."
---

# Установка (setup)

Одна команда мастера: `./setup.sh --all` (сначала `--all --check` — план без
изменений). Состав: pip-пакеты → TTS (Piper + голоса) → запись конфига
OpenCode **с бэкапом** → `sync-plugin.sh` → `doctor.sh`, без вопросов.

## 1. Флаги и автоповедение

| Флаг | Эффект |
|---|---|
| `--all` | всё разом: `DO_TTS=1`, `WRITE_CONFIG=1`, `ASSUME_YES=1` |
| `--gpu` / `--cpu` | явный выбор движка STT; без них `--all` смотрит `nvcc` (есть — GPU, нет — CPU) |
| `--tts` | Piper + голоса: RU (`OPENCODE_VOICE_TTS_VOICES`, по умолч. 4) + EN (`..._EN`, по умолч. `lessac`) |
| `--model-size` | размер ggml-модели для `--gpu` |
| `--check` | только план, ничего не меняет |
| `--write-config` | вписать пути плагина в `~/.config/opencode/*.json` (бэкап `*.bak`) |
| `--no-pip` / `--no-sync` | пропустить pip / генерацию entry-файлов |

## 2. Что переживает перезапуски (порядок важен)

1. `setup.sh --all` пишет `$OPENCODE_VOICE_HOME/env.sh`
   (`OPENCODE_VOICE_TTS=1`, бинарь, каталог голосов) — подключить через
   `source` в `~/.bashrc` (нужно ручным запускам сервера и диагностике).
2. `server-launcher.ts` пытается поднять сервер и выставить `OPENCODE_VOICE_TTS=1`, если флаг
   не задан явно, но текущий V2 local bundle имеет deployment gap: loaded copy не содержит
   `stt-server/`/doctor resources, а launcher может не найти V2 script при `cwd=<SERVICE_CWD>`.
   Поэтому автозапуск и server TTS нельзя считать подтверждёнными до проверки process path и
   `/health` (`tts.available`).
3. Расширение ставится руками: `chrome://extensions` → Load unpacked
   (`extension/`). После **каждого** обновления расширения: Reload + F5
   вкладки, иначе старые content-скрипты осиротеют (тишина без ошибок).

## 3. Первый запуск на новой машине

```sh
bash setup.sh --all --check   # план
bash setup.sh --all           # установка
source ~/.local/share/opencode-voice/env.sh
# перезапустить OpenCode, загрузить расширение, открыть web-UI, F5
# в TUI: /voice doctor ; в popup: движок «Сервер», голос из каталога
curl -s http://127.0.0.1:8765/voices  # каталог голосов
```

## 4. Частые ошибки

- `/speak` → `501 tts disabled` после рестарта → env не подключён **и**
  сервер поднят вручную без флага; не считать V2 launcher автономным, пока не подтверждён
  process path.
- Расширение обновлено, вкладка не перезагружена → осиротевшие скрипты,
  `chrome.*` мёртв; лечение — Reload + F5 (или закрыть вкладку полностью).
- `pytest -k speak` красный с `400` на машине с живыми голосами — предсущий
  затык hermeticity (whitelist против `test-voice`), не регрессия.

## 5. Чек-лист

- [ ] `--all --check` прочитан до запуска
- [ ] `env.sh` записан и подключён
- [ ] конфиг OpenCode обновлён (бэкап на месте), OpenCode перезапущен
- [ ] расширение загружено, `/health` + `/voices` отвечают, `/voice doctor` чист
