#!/usr/bin/env bash
# OpenCode Voice V2 — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice2
# Синхронизирует исходники плагина в загружаемый bundle .opencode/plugins/voice/.
#
# Копируются:
#   src/index.ts                     -> .opencode/plugins/voice/index.ts
#   src/tui.tsx                      -> .opencode/plugins/voice/tui.tsx
#   src/lib/*.ts                     -> .opencode/plugins/voice/lib/
#   stt-server/stt_server.py (+requirements.txt) -> .opencode/plugins/voice/stt-server/
#   shared/*.json                    -> .opencode/plugins/voice/shared/
#   doctor.sh, fix-mic.sh            -> .opencode/plugins/voice/
#
# Ресурсы копируются, потому что launcher и heal ищут их относительно пакета
# (import.meta.url), а не относительно рабочего каталога сервиса: без них
# автостарт STT и /voice doctor ломаются при запуске не из корня проекта.
# Раскладка выбрана так, чтобы stt_server.py (Path(__file__).parents[1]/shared)
# и TS (../../shared/stt-spec.json из src/lib) указывали на один и тот же файл.
#
# Использование:
#   bash sync-plugin.sh           # записать
#   bash sync-plugin.sh --check   # только проверить актуальность (для CI)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$DIR/.opencode/plugins/voice"
MODE="${1:-write}"
CHECK=0
[[ "$MODE" == "--check" ]] && CHECK=1
FAIL=0

# --- одиночный файл (с необязательной трансформацией) -------------------------
sync_one() {
  local src="$1" dst="$2" mode="$3"
  if [[ ! -f "$src" ]]; then
    echo "Нет файла: $src" >&2
    return 1
  fi
  local tmp
  tmp="$(mktemp)"
  # V2: lib копируется в .opencode/plugins/voice/lib/, поэтому "./lib/" не меняется.
  if [[ $# -ge 4 ]]; then
    sed "$4" "$src" > "$tmp"
  else
    cat "$src" > "$tmp"
  fi
  local rel="${dst#"$DIR"/}"
  if [[ "$mode" == "--check" ]]; then
    if [[ -f "$dst" ]] && diff -q "$tmp" "$dst" >/dev/null 2>&1; then
      echo "OK: $rel"
    else
      echo "FAIL: $rel устарел или отсутствует — запусти: bash sync-plugin.sh" >&2
      if [[ -f "$dst" ]]; then diff -u "$dst" "$tmp" | head -40 >&2 || true; fi
      FAIL=1
    fi
    rm -f "$tmp"
    return 0
  fi
  mkdir -p "$(dirname "$dst")"
  cp "$tmp" "$dst"
  rm -f "$tmp"
  echo "Синхронизировано: ${src#"$DIR"/} -> $rel"
}

# --- каталог целиком (по списку файлов) --------------------------------------
sync_dir() {
  local src_dir="$1" dst_dir="$2" mode="$3"
  shift 3
  local name
  for name in "$@"; do
    sync_one "$DIR/$src_dir/$name" "$DEST/$dst_dir/$name" "$mode" || FAIL=1
  done
}

# --- точка входа (entrypoints) ------------------------------------------------
sync_one "$DIR/src/index.ts" "$DEST/index.ts" "$MODE" || FAIL=1
sync_one "$DIR/src/tui.tsx" "$DEST/tui.tsx" "$MODE" || FAIL=1

# --- runtime-библиотека -------------------------------------------------------
mapfile -t LIB_FILES < <(cd "$DIR/src/lib" && ls -1 ./*.ts 2>/dev/null | sed 's#^\./##' | sort)
sync_dir "src/lib" "lib" "$MODE" "${LIB_FILES[@]}" || FAIL=1

# --- ресурсы сервера и диагностики -------------------------------------------
sync_dir "stt-server" "stt-server" "$MODE" stt_server.py requirements.txt || FAIL=1
mapfile -t SHARED_FILES < <(cd "$DIR/shared" && ls -1 ./*.json 2>/dev/null | sed 's#^\./##' | sort)
sync_dir "shared" "shared" "$MODE" "${SHARED_FILES[@]}" || FAIL=1
sync_one "$DIR/doctor.sh" "$DEST/doctor.sh" "$MODE" || FAIL=1
sync_one "$DIR/fix-mic.sh" "$DEST/fix-mic.sh" "$MODE" || FAIL=1

# --- исполняемые биты --------------------------------------------------------
if [[ "$CHECK" -eq 0 ]]; then
  chmod +x "$DEST/doctor.sh" "$DEST/fix-mic.sh" 2>/dev/null || true
  grep -n 'import("' "$DEST/index.ts" || true
fi

exit "$FAIL"
