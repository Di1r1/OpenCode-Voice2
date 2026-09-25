#!/usr/bin/env bash
# OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
#
# fix-mic.sh — восстановление микрофона WSLg.
#
# Пересоздаёт внутренний RDP-канал WSLg (audin), который периодически
# отваливается: WSLGd перезапускает weston и pulseaudio заново. Это чинит
# ситуацию «Аудиоисточник молчит: рекордер подключился, но данных нет».
#
# ВНИМАНИЕ: GUI WSLg перезапустится — окна Wayland-приложений закроются.
#
# Использование:
#   bash fix-mic.sh
#
# Переменные (опционально):
#   WSL_EXE=/mnt/c/Windows/System32/wsl.exe
#   WAIT_WESTON=8   WAIT_PULSE=5   PULSE_SERVER=unix:/mnt/wslg/PulseServer
set -euo pipefail

WSL_EXE="${WSL_EXE:-/mnt/c/Windows/System32/wsl.exe}"
export PULSE_SERVER="${PULSE_SERVER:-unix:/mnt/wslg/PulseServer}"
WAIT_WESTON="${WAIT_WESTON:-8}"
WAIT_PULSE="${WAIT_PULSE:-5}"
TEST_WAV="${TEST_WAV:-/tmp/wslg-mic-test.wav}"

if [[ ! -x "$WSL_EXE" ]]; then
  echo "Ошибка: не найден wsl.exe ($WSL_EXE). Запускать нужно из WSL с interop." >&2
  exit 1
fi

if ! command -v arecord >/dev/null 2>&1; then
  echo "Ошибка: нет arecord. Установи: sudo apt-get install -y alsa-utils" >&2
  exit 1
fi

echo "[1/3] Пересоздаю weston (WSLGd поднимет его заново)..."
"$WSL_EXE" --system -e sh -lc 'pkill -9 -x weston' >/dev/null 2>&1 || true
sleep "$WAIT_WESTON"

echo "[2/3] Перезапускаю pulseaudio..."
"$WSL_EXE" --system -e sh -lc 'pkill -9 -x pulseaudio' >/dev/null 2>&1 || true
sleep "$WAIT_PULSE"

echo "[3/3] Проверка записи (3 с)..."
rm -f "$TEST_WAV"
if timeout -s KILL 12 arecord -D pulse -f cd -d 3 "$TEST_WAV" >/dev/null 2>&1; then
  size="$(stat -c%s "$TEST_WAV" 2>/dev/null || echo 0)"
  rm -f "$TEST_WAV"
  if [[ "$size" -gt 2000 ]]; then
    echo "OK: микрофон работает (записано $size байт)."
    exit 0
  fi
fi
rm -f "$TEST_WAV"

echo "FAIL: микрофон всё ещё молчит." >&2
echo "Попробуй полный рестарт (из Windows PowerShell): wsl --shutdown" >&2
exit 2
