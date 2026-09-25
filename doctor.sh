#!/usr/bin/env bash
# OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
# Доктор для кнопки/расширения OpenCode Voice: диагностика и ремонт.
#
#   ./doctor.sh          # только диагностика
#   ./doctor.sh --fix    # + авто-ремонт (сервер, зависшая запись, микрофон)
#
# Проверяет: сервер (процесс/порт/health), CORS (X-Voice-Source/X-Voice-Token),
# зависшую запись, состояние микрофона (уровни и скорость доставки), свежесть
# логов. Ничего не требует, кроме bash/curl/python3 (+ arecord для пробы).
set -uo pipefail

FIX=0
[[ "${1:-}" == "--fix" ]] && FIX=1

PORT="${OPENCODE_VOICE_PORT:-8765}"
HOST="${OPENCODE_VOICE_HOST:-127.0.0.1}"
BASE="http://${HOST}:${PORT}"
PULSE_SERVER="${PULSE_SERVER:-unix:/mnt/wslg/PulseServer}"
export PULSE_SERVER
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG="/tmp/opencode/stt_server.log"
REQ_LOG="/tmp/opencode/voice-requests.log"
REC_LOG="/tmp/opencode/voice-recognized.log"
EXT_ORIGIN="chrome-extension://abcdefghijklmnopabcdefghijklmnop"

OK="✅"; WARN="⚠️"; BAD="❌"
issues=()
fixed=()

say() { printf '%s %s\n' "$1" "$2"; }

server_pid() { pgrep -f 'stt_server\.py' | head -1; }
port_up() { ss -ltn 2>/dev/null | grep -q ":${PORT}\b"; }

wait_server() { # до ~150 c
  for _ in $(seq 1 25); do
    if port_up && curl -sf -m 3 "$BASE/health" >/dev/null 2>&1; then return 0; fi
    sleep 6
  done
  return 1
}

echo "== OpenCode Voice: доктор =="
echo "плагин: ${SCRIPT_DIR}"
echo

# 1) Сервер: процесс и порт ------------------------------------------------
if port_up; then
  PID="$(ss -ltnp 2>/dev/null | grep ":${PORT}\b" | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)"
  say "$OK" "Сервер слушает ${BASE} (PID ${PID:-?})"
else
  say "$BAD" "Сервер НЕ слушает ${BASE} — кнопка получит 'Failed to fetch'"
  issues+=("server-down")
  if [[ $FIX -eq 1 ]]; then
    P="$(server_pid || true)"
    if [[ -n "${P:-}" ]]; then
      kill "$P" 2>/dev/null || true
      say "…" "сервер остановлен (PID $P); ждём watchdog…"
    else
      say "…" "процесс не найден; ждём watchdog…"
    fi
    if wait_server; then say "$OK" "Сервер поднялся (авто)"; fixed+=("server-restart"); else
      say "$WARN" "watchdog не поднял за ~150 c — перезапусти OpenCode"; fi
  fi
fi

# 2) health -----------------------------------------------------------------
HEALTH="$(curl -sf -m 5 "$BASE/health" 2>/dev/null || true)"
if [[ -n "$HEALTH" ]]; then
  say "$OK" "health: $HEALTH"
  AUTH="$(python3 -c "import sys,json;print(json.loads(sys.argv[1]).get('auth'))" "$HEALTH" 2>/dev/null)"
  if [[ "$AUTH" == "True" ]]; then
    say "$WARN" "на сервере задан OPENCODE_VOICE_TOKEN — в popup расширения должен быть тот же токен (иначе 401)"
  fi
else
  say "$BAD" "health недоступен"
fi

# 2b) TTS (серверный синтез) ------------------------------------------------
if [[ -n "$HEALTH" ]]; then
  TTS_LINE="$(python3 - "$HEALTH" <<'PY' 2>/dev/null || true
import sys, json
try:
    t = json.loads(sys.argv[1]).get("tts") or {}
except Exception:
    t = {}
print("enabled=%s available=%s engine=%s voice=%s" % (
    t.get("enabled"), t.get("available"), t.get("engine") or "?", t.get("voice") or "?"))
PY
)"
  if [[ "$TTS_LINE" == *"enabled=True available=True"* ]]; then
    say "$OK" "TTS: движок готов (${TTS_LINE#enabled=True available=True })"
  elif [[ "$TTS_LINE" == *"enabled=True"* ]]; then
    say "$WARN" "TTS включён, но движок недоступен ($TTS_LINE) — ./setup.sh --tts"
    issues+=("tts")
  else
    say "…" "TTS выключен (${TTS_LINE:-n/a}); включение: OPENCODE_VOICE_TTS=1 + ./setup.sh --tts"
  fi
fi

# 3) CORS preflight ---------------------------------------------------------
CORS="$(curl -s -m 5 -X OPTIONS "$BASE/beep" \
  -H "Origin: ${EXT_ORIGIN}" -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: x-voice-source,x-voice-token' -D - -o /dev/null \
  | grep -i '^access-control-allow-headers:' | tr -d '\r')"
if echo "$CORS" | grep -qi 'x-voice-source'; then
  say "$OK" "CORS: X-Voice-Source разрешён"
else
  say "$BAD" "CORS не разрешает X-Voice-Source (${CORS:-нет заголовка}) — кнопка получит 'Failed to fetch'"
  issues+=("cors")
  if [[ $FIX -eq 1 && -z "$(printf '%s\n' "${fixed[@]:-}")" ]]; then
    P="$(server_pid || true)"; [[ -n "${P:-}" ]] && kill "$P" 2>/dev/null || true
    if wait_server; then say "$OK" "Сервер перезапущен с новым CORS"; fixed+=("cors"); fi
  else
    say "…" "лечится перезапуском STT-сервера (после правок CORS)"
  fi
fi

# 4) Зависшая запись --------------------------------------------------------
STATUS="$(curl -sf -m 5 "$BASE/record/status" 2>/dev/null || true)"
if echo "$STATUS" | grep -q '"recording": *true'; then
  say "$WARN" "на сервере активна запись (кнопка может получать 409 'already recording')"
  issues+=("stuck-recording")
  if [[ $FIX -eq 1 ]]; then
    curl -sf -m 8 -X POST "$BASE/record/stop" >/dev/null 2>&1 && { say "$OK" "запись сброшена"; fixed+=("stuck"); }
  fi
else
  say "$OK" "активной записи нет"
fi

# 5) Микрофон: уровень и скорость доставки ---------------------------------
if command -v arecord >/dev/null; then
  TMP="$(mktemp /tmp/opencode/doctor-XXXX.wav)"
  S=$(date +%s.%N)
  if PULSE_SOURCE="${OPENCODE_VOICE_SOURCE:-RDPSource}" timeout 40 arecord -D pulse -f S16_LE -r 16000 -c 1 -t wav -d 3 "$TMP" >/dev/null 2>&1; then
    E=$(date +%s.%N)
    python3 - "$TMP" "$S" "$E" <<'PY' || true
import sys, wave, array
path, s, e = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
try:
    with wave.open(path, "rb") as w:
        sr, n = w.getframerate(), w.getnframes(); a = array.array("h"); a.frombytes(w.readframes(n))
except Exception as ex:
    print("⚠️  микрофон: не удалось прочитать запись:", ex); raise SystemExit
dur, wall = n / sr, (e - s)
peak = max(abs(x) for x in a) if a else 0
rms = (sum(x * x for x in a) / len(a)) ** 0.5 if a else 0
ratio = dur / wall if wall else 0
if peak <= 2:
    print(f"⚠️  микрофон: цифровая тишина (peak={peak}); канал мёртв/нет сигнала — запусти fix-mic.sh")
elif ratio < 0.7:
    print(f"⚠️  микрофон: медленный канал ({ratio:.2f}x) — звук приходит с потерями (клиент/audin)")
else:
    print(f"✅ микрофон: доставка {ratio:.2f}x, peak={peak:.0f}, rms={rms:.0f}")
PY
  else
    say "$BAD" "микрофон: arecord не смог записать (канал мёртв) — запусти fix-mic.sh"
    issues+=("mic")
    if [[ $FIX -eq 1 && -x "${SCRIPT_DIR}/fix-mic.sh" ]]; then
      bash "${SCRIPT_DIR}/fix-mic.sh" >/dev/null 2>&1 && { say "$OK" "fix-mic.sh выполнен"; fixed+=("mic"); } || say "$WARN" "fix-mic.sh не помог"
    fi
  fi
  rm -f "$TMP" 2>/dev/null || true
else
  say "$WARN" "arecord не найден — пробу микрофона пропускаю"
fi

# 6) Свежесть логов ---------------------------------------------------------
for f in "$REQ_LOG" "$REC_LOG" "$LOG" "/tmp/opencode/voice-tts.log"; do
  if [[ -f "$f" ]]; then
    say "…" "$(basename "$f"): последнее изменение $(date -r "$f" '+%H:%M:%S' 2>/dev/null), размер $(stat -c%s "$f") б"
  fi
done
[[ -f "$REQ_LOG" ]] && { echo "… последние запросы:"; tail -3 "$REQ_LOG" | sed 's/^/    /'; }
[[ -f "$REC_LOG" ]] && { echo "… последние распознавания:"; tail -3 "$REC_LOG" | sed 's/^/    /'; }

echo
if [[ ${#issues[@]} -eq 0 ]]; then
  echo "Итог: проблем не найдено."
else
  echo "Итог: проблемы — ${issues[*]}"
  [[ $FIX -eq 1 ]] && echo "Авто-ремонт: ${fixed[*]:-не потребовался}"
  cat <<'TIPS'
Подсказки:
 - 'Failed to fetch' = сервер не слушает порт ИЛИ CORS не разрешает X-Voice-Source.
 - 401 = токен в popup расширения не совпадает с OPENCODE_VOICE_TOKEN на сервере.
 - 409 'already recording' = зависшая запись, лечится POST /record/stop (doctor --fix).
 - тишина/медленный канал = fix-mic.sh, затем повторить.
TIPS
fi
