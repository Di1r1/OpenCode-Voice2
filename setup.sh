#!/usr/bin/env bash
# OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
# OpenCode Voice — установка "под ключ".
#
# По умолчанию (CPU): проверяет зависимости, ставит Python-пакеты (faster-whisper),
# генерирует entry-файлы плагина и показывает, что прописать в конфиге OpenCode.
# С --gpu дополнительно собирает whisper.cpp с CUDA и скачивает ggml-модель.
#
# Использование:
#   ./setup.sh                     # CPU: зависимости + проверки
#   ./setup.sh --all               # мастер одной команды: всё разом (pip, TTS, конфиг, env, doctor)
#   ./setup.sh --gpu               # + собрать whisper.cpp (CUDA) + модель
#   ./setup.sh --cpu               # принудительно CPU-путь (без сборки whisper.cpp)
#   ./setup.sh --tts               # + скачать Piper и голоса (серверная озвучка, POST /speak)
#   ./setup.sh --model-size small  # размер ggml-модели для --gpu (tiny|base|small|medium|large-v3)
#   ./setup.sh --check             # только проверить окружение и показать план (ничего не менять)
#   ./setup.sh --configure         # показать строки для конфига OpenCode
#   ./setup.sh --write-config      # то же + вписать пути в ~/.config/opencode/*.json (с бэкапом)
#   ./setup.sh --yes, -y           # не задавать вопросов
#   ./setup.sh --rules              # развернуть правила озвучки для ассистента
#                                   # в ~/.config/opencode/AGENTS.md (правило «помечай 🔈»)
#   ./setup.sh --uninstall-rules   # вырезать эти правила обратно
#   ./setup.sh --no-pip            # не ставить Python-пакеты
#   ./setup.sh --no-sync           # не генерировать entry-файлы плагина
#
# Переменные: OPENCODE_VOICE_HOME (по умолчанию ~/.local/share/opencode-voice),
#             OPENCODE_VOICE_WHISPER_DIR (по умолчанию $OPENCODE_VOICE_HOME/whisper),
#             CUDA_HOME/CUDA_PATH (если CUDA Toolkit в нестандартном месте);
#             OPENCODE_VOICE_TTS_HOME/VOICES_DIR (для --tts),
#             OPENCODE_VOICE_TTS_VOICES(_EN)(_PL) (наборы голосов RU/EN/PL).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

MODE_GPU=0
GPU_EXPLICIT=0
CHECK_ONLY=0
ASSUME_YES=0
DO_PIP=1
DO_SYNC=1
CONFIGURE=0
WRITE_CONFIG=0
DO_TTS=0
DO_ALL=0
DO_RULES=0
UNDO_RULES=0
MODEL_SIZE="${WHISPER_CPP_MODEL_SIZE:-medium}"

HOME_DIR="${OPENCODE_VOICE_HOME:-$HOME/.local/share/opencode-voice}"
WHISPER_DIR="${OPENCODE_VOICE_WHISPER_DIR:-$HOME_DIR/whisper}"
TTS_DIR="${OPENCODE_VOICE_TTS_HOME:-$HOME_DIR/tts}"
TTS_PIPER_DIR="$TTS_DIR/piper"
TTS_VOICES_DIR="${OPENCODE_VOICE_TTS_VOICES_DIR:-$TTS_DIR/voices}"
OPENCODE_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"

# Вспомогательные функции — до pick_config_file: тот зовёт warn() при первом же
# запуске, и без них предупреждение о двух конфигах молча пропадало.
C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_OFF=$'\033[0m'
ok()   { printf '%s✓%s %s\n' "$C_OK" "$C_OFF" "$*"; }
# warn и err пишут в stderr. Иначе предупреждение внутри $( ) подменяет
# stdout: pick_config_file вызывается как OPENCODE_CONFIG_FILE="$(pick_config_file)",
# и при двух конфигах (opencode.json + opencode.jsonc) путь забивался текстом
# предупреждения — -f его не находил, и --write-config писал не туда.
warn() { printf '%s!%s %s\n' "$C_WARN" "$C_OFF" "$*" >&2; }
err()  { printf '%s✗%s %s\n' "$C_ERR" "$C_OFF" "$*" >&2; }
info() { printf '%s·%s %s\n' "$C_DIM" "$C_OFF" "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# OpenCode читает и opencode.json, и opencode.jsonc. Если файлов два, берем
# более новый и обязательно предупреждаем: два файла конфига — классическая
# причина "плагин то подключен, то нет".
pick_config_file() {
  local j="$OPENCODE_CONFIG_DIR/opencode.json" jc="$OPENCODE_CONFIG_DIR/opencode.jsonc"
  if [ -f "$j" ] && [ -f "$jc" ]; then
    warn "ВНИМАНИЕ: существуют оба конфига — opencode.json и opencode.jsonc."
    warn "OpenCode прочитает только один. Сведите их к одному файлу вручную."
    if [ "$j" -nt "$jc" ]; then echo "$j"; else echo "$jc"; fi
  elif [ -f "$j" ]; then echo "$j"
  elif [ -f "$jc" ]; then echo "$jc"
  else echo "$OPENCODE_CONFIG_DIR/opencode.jsonc"
  fi
}
OPENCODE_CONFIG_FILE="$(pick_config_file)"


while [ $# -gt 0 ]; do
  arg="$1"; shift
  case "$arg" in
    --gpu) MODE_GPU=1; GPU_EXPLICIT=1 ;;
    --cpu) MODE_GPU=0; GPU_EXPLICIT=1 ;;
    --tts) DO_TTS=1 ;;
    --all) DO_ALL=1 ;;
    --rules) DO_RULES=1 ;;
    --uninstall-rules) UNDO_RULES=1 ;;
    --check) CHECK_ONLY=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    --no-pip) DO_PIP=0 ;;
    --no-sync) DO_SYNC=0 ;;
    --configure) CONFIGURE=1 ;;
    --write-config) CONFIGURE=1; WRITE_CONFIG=1 ;;
    --model-size) MODEL_SIZE="${1:?--model-size требует значение}"; shift ;;
    --model-size=*) MODEL_SIZE="${arg#*=}" ;;
    # Печатаем ведущий блок комментария целиком. Раньше был жёсткий диапазон
    # '2,27p', и любая правка usage его обрезала.
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) err "неизвестный флаг: $arg (см. --help)"; exit 2 ;;
  esac
done

in_wsl() { grep -qi microsoft /proc/version 2>/dev/null; }

# Мастер одной команды: pip + TTS + запись конфига + env-файл + doctor, без вопросов.
# GPU — только если CUDA видна (явные --gpu/--cpu побеждают авто).
if [ "$DO_ALL" = "1" ]; then
  DO_TTS=1; CONFIGURE=1; WRITE_CONFIG=1; ASSUME_YES=1
  if [ "$GPU_EXPLICIT" != "1" ]; then
    if have nvcc; then MODE_GPU=1; else MODE_GPU=0; fi
  fi
fi

# --yes без --all: всё без вопросов, включая запись конфига
if [ "$ASSUME_YES" = "1" ] && [ "$DO_ALL" = "0" ]; then
  CONFIGURE=1; WRITE_CONFIG=1
fi

echo "OpenCode Voice — установка"
info "репозиторий:  $REPO"
info "модель/каталог: $WHISPER_DIR (размер: $MODEL_SIZE)"
[ "$MODE_GPU" = "1" ] && info "режим: GPU (whisper.cpp + CUDA)" || info "режим: CPU (faster-whisper)"
[ "$DO_TTS" = "1" ] && info "TTS: Piper + голоса RU/EN -> $TTS_DIR"
[ "$DO_ALL" = "1" ] && info "мастер: всё разом, конфиг пишется, env — в $HOME_DIR/env.sh"
echo

# ---------------------------------------------------------------------------
# 1. Проверка окружения
# ---------------------------------------------------------------------------
echo "== Проверка зависимостей =="
MISSING=0
need() {
  local cmd="$1" hint="$2"
  if have "$cmd"; then ok "$cmd"; else warn "$cmd не найден — $hint"; MISSING=1; fi
}

if have python3; then
  PYVER="$(python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])' 2>/dev/null || echo 0.0)"
  case "$PYVER" in
    3.[0-8]) warn "Python $PYVER < 3.9 — нужен 3.9+"; MISSING=1 ;;
    *) ok "python3 $PYVER" ;;
  esac
else
  warn "python3 не найден — нужен Python 3.9+"; MISSING=1
fi
have node && ok "node $(node -v 2>/dev/null)" || warn "node не найден — нужен Node.js 20+ (для плагина), 22.6+ для npm test"
need npm "нужен для плагина"
need ffmpeg "нужен для конвертации WebM/Opus из браузера"
need curl "нужен для скачивания модели (--gpu)"
if [ "$DO_TTS" = "1" ]; then need tar "нужен для распаковки Piper (--tts)"; fi
if have arecord; then ok "arecord (alsa-utils)"; else
  if in_wsl; then warn "arecord не найден — в WSLg: sudo apt-get install -y alsa-utils libasound2-plugins"; else
    warn "arecord не найден — sudo apt-get install -y alsa-utils"; fi
fi
in_wsl && ok "окружение WSL2 (микрофон через WSLg PulseAudio)" || info "не WSL2: задайте OPENCODE_VOICE_SOURCE (pactl get-default-source)"

# ---------------------------------------------------------------------------
# 1b. Автоустановка системных пакетов (Linux apt-based)
# ---------------------------------------------------------------------------
if [ "$CHECK_ONLY" = "0" ] && have apt-get 2>/dev/null && have dpkg 2>/dev/null; then
  APT_INSTALL=()

  if ! python3 -m pip --version >/dev/null 2>&1; then
    APT_INSTALL+=("python3-pip" "python3-venv")
  fi

  if ! have arecord; then
    if in_wsl; then
      APT_INSTALL+=("alsa-utils" "libasound2-plugins")
    else
      APT_INSTALL+=("alsa-utils")
    fi
  fi

  if ! have ffmpeg; then
    APT_INSTALL+=("ffmpeg")
  fi

  if [ ${#APT_INSTALL[@]} -gt 0 ]; then
    echo
    info "доустанавливаю системные пакеты: ${APT_INSTALL[*]}..."
    if sudo apt-get install -y "${APT_INSTALL[@]}"; then
      ok "системные пакеты установлены"
    else
      warn "apt-get install не удался — установите вручную: sudo apt-get install -y ${APT_INSTALL[*]}"
    fi
  fi
fi

if [ "$MODE_GPU" = "1" ]; then
  echo
  echo "== Проверка GPU-сборки =="
  need cmake "нужен для сборки whisper.cpp"
  need git "нужен для сборки whisper.cpp"
  CUDA_ROOT="${CUDA_HOME:-${CUDA_PATH:-}}"
  if [ -z "$CUDA_ROOT" ]; then
    for d in /usr/local/cuda ~/cuda-12.6 ~/cuda-12.4 ~/cuda /opt/cuda; do [ -d "$d" ] && { CUDA_ROOT="$d"; break; }; done
  fi
  if [ -n "$CUDA_ROOT" ] && [ -x "$CUDA_ROOT/bin/nvcc" ]; then
    export CUDA_HOME="$CUDA_ROOT"
    export PATH="$CUDA_ROOT/bin:$PATH"
    ok "CUDA Toolkit: $CUDA_ROOT ($("$CUDA_ROOT/bin/nvcc" --version 2>/dev/null | grep -oE 'release [0-9.]+' | head -1))"
  elif have nvcc; then
    CUDA_ROOT="$(dirname "$(dirname "$(command -v nvcc)")")"
    ok "CUDA Toolkit: $(command -v nvcc)"
  else
    warn "CUDA Toolkit (nvcc) не найден — установите CUDA 12.x или задайте CUDA_HOME"
  fi
  have nvidia-smi && info "GPU: $(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1 || echo '?')"
fi

if [ "$CHECK_ONLY" = "1" ]; then
  echo
  [ "$MISSING" = "1" ] && warn "чего-то не хватает (см. выше) — установите и повторите" || ok "окружение готово"
  echo
  echo "== План (--check ничего не меняет) =="
  n=0
  if [ "$DO_PIP" = "1" ]; then n=$((n+1)); echo "  $n. python3 -m pip install -r stt-server/requirements.txt (faster-whisper)"; fi
  if [ "$MODE_GPU" = "1" ]; then n=$((n+1)); echo "  $n. собрать whisper.cpp с CUDA и скачать ggml-$MODEL_SIZE.bin в $WHISPER_DIR"; fi
  if [ "$DO_TTS" = "1" ]; then n=$((n+1)); echo "  $n. скачать Piper и голоса — русские (${OPENCODE_VOICE_TTS_VOICES:-irina dmitri denis ruslan}), английские (${OPENCODE_VOICE_TTS_VOICES_EN:-lessac}), польские (${OPENCODE_VOICE_TTS_VOICES_PL:-gosia darkman}) в $TTS_DIR"; fi
  if [ "$DO_TTS" = "1" ]; then n=$((n+1)); echo "  $n. записать $HOME_DIR/env.sh (OPENCODE_VOICE_TTS=1, бинарь и каталог голосов)"; fi
  if [ "$WRITE_CONFIG" = "1" ]; then n=$((n+1)); echo "  $n. записать пути плагина в конфиг OpenCode (с бэкапом)"; fi
  if [ "$DO_SYNC" = "1" ]; then n=$((n+1)); echo "  $n. bash sync-plugin.sh (сгенерировать entry-файлы)"; fi
  n=$((n+1)); echo "  $n. показать строки для ~/.config/opencode/opencode.jsonc (V2: plugins + skills)"
  n=$((n+1)); echo "  $n. bash doctor.sh"
  exit 0
fi

# ---------------------------------------------------------------------------
# 2. Python-зависимости (CPU-путь: faster-whisper)
# ---------------------------------------------------------------------------
echo
echo "== Python-зависимости =="
REQ="$HERE/stt-server/requirements.txt"
if [ "$DO_PIP" = "1" ]; then
  if [ -f "$REQ" ]; then
    if python3 -m pip --version >/dev/null 2>&1; then
      info "pip install -r $REQ (может занять пару минут)"
      if python3 -m pip install --break-system-packages -r "$REQ"; then ok "Python-пакеты установлены"; else
        warn "pip install не удался — поставьте вручную: python3 -m pip install --break-system-packages -r $REQ"; fi
    else
      warn "pip недоступен (python3 -m ensurepip --upgrade, либо apt-get install python3-pip)"
    fi
  else
    warn "нет $REQ"
  fi
else
  info "пропущено (--no-pip)"
fi

# ---------------------------------------------------------------------------
# 3. whisper.cpp + ggml-модель (--gpu)
# ---------------------------------------------------------------------------
if [ "$MODE_GPU" = "1" ]; then
  echo
  echo "== whisper.cpp (CUDA) =="
  SRC_DIR="${OPENCODE_VOICE_WHISPER_SRC:-$HOME_DIR/src/whisper.cpp}"
  BIN_DIR="$WHISPER_DIR/bin"
  mkdir -p "$WHISPER_DIR" "$BIN_DIR"

  if [ ! -d "$SRC_DIR" ]; then
    mkdir -p "$(dirname "$SRC_DIR")"
    info "git clone whisper.cpp -> $SRC_DIR"
    git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$SRC_DIR" || warn "clone не удался"
  else
    info "использую существующий $SRC_DIR"
  fi

  if [ -d "$SRC_DIR" ]; then
    CUDA_ROOT="${CUDA_HOME:-${CUDA_PATH:-/usr/local/cuda}}"
    CC_ARCH="75"
    if have nvidia-smi; then
      CAP="$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -d ' ')"; [ -n "$CAP" ] && CC_ARCH="$(echo "$CAP" | tr -d '.')"
    fi
    info "CUDA arch: $CC_ARCH, toolkit: $CUDA_ROOT"
    JOBS="$(nproc 2>/dev/null || echo 4)"
    CMAKE_ARGS=(
      -S "$SRC_DIR" -B "$SRC_DIR/build-cuda"
      -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES="$CC_ARCH" -DCMAKE_BUILD_TYPE=Release
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON
      -DCUDAToolkit_ROOT="$CUDA_ROOT" -DCMAKE_CUDA_FLAGS=-allow-unsupported-compiler
    )
    if [ -d "$CUDA_ROOT/lib64" ]; then
      CMAKE_ARGS+=( -DCMAKE_EXE_LINKER_FLAGS="-L$CUDA_ROOT/lib64 -Wl,--copy-dt-needed-entries -Wl,-rpath,$CUDA_ROOT/lib64" )
    fi
    if cmake "${CMAKE_ARGS[@]}" \
      && cmake --build "$SRC_DIR/build-cuda" --config Release -j"$JOBS" --target whisper-cli; then
      ok "whisper-cli собран"
      BB="$SRC_DIR/build-cuda/bin"
      [ -f "$BB/whisper-cli" ] && cp -af "$BB/whisper-cli" "$BIN_DIR/" || true
      cp -af "$BB"/*.so* "$BIN_DIR/" 2>/dev/null || true
      ok "бинарник и библиотеки -> $BIN_DIR"
    else
      warn "сборка whisper.cpp не удалась — останется CPU-путь (faster-whisper)"
    fi
  fi

  MODEL="$WHISPER_DIR/ggml-$MODEL_SIZE.bin"
  if [ -s "$MODEL" ]; then
    ok "модель уже есть: $MODEL"
  else
    URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODEL_SIZE.bin"
    info "скачиваю ggml-$MODEL_SIZE.bin ($URL)"
    if curl -fL --retry 3 -o "$MODEL.part" "$URL"; then mv -f "$MODEL.part" "$MODEL"; ok "модель: $MODEL"; else
      rm -f "$MODEL.part"; warn "не удалось скачать модель — скачайте вручную в $WHISPER_DIR"
    fi
  fi

  echo
  info "проверка GPU-пути:"
  if [ -x "$BIN_DIR/whisper-cli" ] && [ -s "$MODEL" ]; then
    if LD_LIBRARY_PATH="$BIN_DIR:${CUDA_ROOT}/lib64:/usr/lib/wsl/lib:${LD_LIBRARY_PATH:-}" \
        "$BIN_DIR/whisper-cli" --help >/dev/null 2>&1; then
      ok "whisper-cli запускается (LD_LIBRARY_PATH найден)"
    else
      warn "whisper-cli не запустился — проверьте CUDA-драйвер/библиотеки (doctor.sh)"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 3b. TTS: Piper + голос (--tts)
# ---------------------------------------------------------------------------
if [ "$DO_TTS" = "1" ]; then
  echo
  echo "== TTS: Piper + голос =="
  mkdir -p "$TTS_PIPER_DIR" "$TTS_VOICES_DIR"

  PIPER_BIN="$TTS_PIPER_DIR/piper"
  if [ -x "$PIPER_BIN" ]; then
    ok "piper уже установлен: $PIPER_BIN"
  else
    PIPER_URL="https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz"
    info "скачиваю Piper ($PIPER_URL)"
    if curl -fL --retry 3 -o "$TTS_DIR/piper.tar.gz" "$PIPER_URL" \
       && tar -xzf "$TTS_DIR/piper.tar.gz" -C "$TTS_DIR"; then
      rm -f "$TTS_DIR/piper.tar.gz"
      if [ -x "$PIPER_BIN" ]; then ok "piper: $PIPER_BIN"; else
        warn "Piper распакован, но бинарь не найден — проверьте $TTS_DIR/piper"
      fi
    else
      rm -f "$TTS_DIR/piper.tar.gz"
      warn "не удалось скачать Piper — вручную: https://github.com/rhasspy/piper/releases"
    fi
  fi

  # Голоса Piper (medium, ~63 МБ каждый). Русский, английский и польский: без
  # голоса нужного языка синтез читает чужой текст с чужой фонетикой, и это
  # слышно. Все попадают в каталог GET /voices, то есть в выпадающий список
  # popup без перезапуска сервера.
  # Переопределить: OPENCODE_VOICE_TTS_VOICES="irina dmitri" (имена без префикса
  # и суффикса), _EN, _PL соответственно.
  tts_install_voices() {
    local lang_code="$1" lang_dir="$2" names="$3" name vname vbase ext f
    for name in $names; do
      vname="${lang_code}-${name}-medium"
      vbase="https://huggingface.co/rhasspy/piper-voices/resolve/main/${lang_dir}/${lang_code}/${name}/medium/${vname}"
      for ext in onnx onnx.json; do
        f="$TTS_VOICES_DIR/$vname.$ext"
        if [ -s "$f" ]; then ok "голос уже есть: $vname.$ext"; continue; fi
        info "скачиваю $vname.$ext"
        if curl -fL --retry 3 -o "$f.part" "$vbase.$ext"; then
          mv -f "$f.part" "$f"; ok "$vname.$ext"
        else
          rm -f "$f.part"; warn "не удалось скачать $vname.$ext"
        fi
      done
    done
  }

  tts_install_voices ru_RU ru/ru_RU "${OPENCODE_VOICE_TTS_VOICES:-irina dmitri denis ruslan}"
  tts_install_voices en_US en/en_US "${OPENCODE_VOICE_TTS_VOICES_EN:-lessac}"
  tts_install_voices pl_PL pl/pl_PL "${OPENCODE_VOICE_TTS_VOICES_PL:-gosia darkman}"

  echo
  info "серверный TTS выключен по умолчанию — включите переменными ТАМ, откуда стартует OpenCode:"
  echo "    export OPENCODE_VOICE_TTS=1   # сервер читает флаг один раз при старте; heal/вотчдог его не включат"
  echo "    OPENCODE_VOICE_TTS_BIN=$PIPER_BIN"
  echo "    OPENCODE_VOICE_TTS_VOICES_DIR=$TTS_VOICES_DIR"
  echo "  Затем перезапустите сервер; в popup расширения выберите движок «Сервер»; диагностика — ./doctor.sh"
  # Сохраняем переменные в файл, чтобы переживали перезапуски шелла/машины.
  ENV_FILE="$HOME_DIR/env.sh"
  {
    echo "# OpenCode Voice env (сгенерировано setup.sh). Подключите: source \"$ENV_FILE\""
    echo "export OPENCODE_VOICE_TTS=1"
    echo "export OPENCODE_VOICE_TTS_BIN=\"$PIPER_BIN\""
    echo "export OPENCODE_VOICE_TTS_VOICES_DIR=\"$TTS_VOICES_DIR\""
  } > "$ENV_FILE"
  ok "env-файл: $ENV_FILE (добавьте 'source \"$ENV_FILE\"' в ~/.bashrc)"
fi

# ---------------------------------------------------------------------------
# 4. Entry-файлы плагина (sync) + проверка
# ---------------------------------------------------------------------------
# V2: команда /voice регистрируется самим плагином (ctx.command.transform),
# отдельный .opencode/commands/voice.md больше не нужен.

if [ "$DO_SYNC" = "1" ] && [ -x "$HERE/sync-plugin.sh" ]; then
  echo
  echo "== Плагин =="
  if bash "$HERE/sync-plugin.sh" >/dev/null 2>&1; then ok "entry-файлы сгенерированы ($HERE/.opencode/)"; else
    warn "sync-plugin.sh завершился с ошибкой — запустите вручную: bash $HERE/sync-plugin.sh"; fi
fi

# Правила озвучки для ассистента. Кладутся в глобальные инструкции OpenCode,
# поэтому действуют во всех сессиях и на любой машине после установки. Текст
# берётся из shared/tts-manifest.json, раздел assistant — отсюда он
# переезжает вместе с плагином и не расходится с кодом.
# Блок обрамлён маркерами: повторный запуск обновляет, uninstall вырезает.
if [ "$UNDO_RULES" = "1" ] || [ "$DO_RULES" = "1" ]; then
  echo
  echo "== Правила озвучки для ассистента =="
  RULES_SCRIPT="$HERE/scripts/assistant-rules.mjs"
  NODE_BIN="$(command -v node || true)"
  if [ -z "$NODE_BIN" ] && [ -x "$HOME/.local/opt/node22/bin/node" ]; then NODE_BIN="$HOME/.local/opt/node22/bin/node"; fi
  if [ -z "$NODE_BIN" ]; then
    warn "node не найден — правила не развернуты. Поставь Node 22 и повтори: ./setup.sh --rules"
  elif [ ! -f "$RULES_SCRIPT" ]; then
    warn "нет $RULES_SCRIPT — правила не развернуты"
  else
    if [ "$UNDO_RULES" = "1" ]; then
      if "$NODE_BIN" "$RULES_SCRIPT" uninstall 2>&1 | sed 's/^/  /'; then
        ok "правила озвучки вырезаны"
      else
        warn "не удалось вырезать правила"
      fi
    else
      if "$NODE_BIN" "$RULES_SCRIPT" install 2>&1 | sed 's/^/  /'; then
        ok "ассистент получил правило «помечай 🔈 в каждом ответе»"
        info "перезапусти Opencode — глобальные инструкции читаются при старте"
      else
        warn "правила не установлены — запусти вручную: $NODE_BIN $RULES_SCRIPT install"
      fi
    fi
  fi
fi

# Копируем .opencode/plugins/voice/ (index.ts + tui.tsx), чтобы OpenCode мог загрузить плагин
PLUGINS_SRC="$HERE/.opencode/plugins/voice"
PLUGINS_DST="$HERE/.opencode/plugins/voice"
if [ -d "$PLUGINS_SRC" ] && [ "$DO_SYNC" = "1" ]; then
  mkdir -p "$PLUGINS_DST"
  cp -f "$PLUGINS_SRC"/*.ts "$PLUGINS_DST/" 2>/dev/null || true
  cp -f "$PLUGINS_SRC"/*.tsx "$PLUGINS_DST/" 2>/dev/null || true
  info "плагин синхронизирован -> $PLUGINS_DST"
fi

# ---------------------------------------------------------------------------
# 4b. Node-зависимости: без них typecheck/build МОЛЧА ВРУТ (tsc не найден,
#     а exit code остается 0). Ставим lock-файл, если он есть.
# ---------------------------------------------------------------------------
if command -v npm >/dev/null 2>&1; then
  if [ -f package-lock.json ]; then
    if npm ci >/dev/null 2>&1; then ok "node-зависимости установлены (npm ci)"
    else warn "npm ci не удался — если проект на /mnt/c (v9fs), помогает перенос в файловую систему Linux"; fi
  else
    if npm install >/dev/null 2>&1; then ok "node-зависимости установлены (npm install)"
    else warn "npm install не удался — typecheck/build останутся нерабочими"; fi
  fi
else
  warn "npm не найден: поставьте Node 22.6+ — без него npm test и typecheck не работают"
fi

# ---------------------------------------------------------------------------
# 5. Конфиг OpenCode: показать (или записать с --write-config)
# ---------------------------------------------------------------------------
PLUGIN_ENTRY="$HERE/.opencode/plugins/voice"

print_config() {
  cat <<EOF
Добавьте в $OPENCODE_CONFIG_FILE (команда /voice регистрируется
самим плагином, отдельный блок commands не нужен; TUI-часть подхватывается
автоматически вместе с плагином):

  "plugins": [
    {"package": "file://$PLUGIN_ENTRY", "options": {}}
  ],
  "skills": ["$HERE/.opencode/skills"]

После правки конфига перезапустите OpenCode.
EOF
}

echo
if [ "$CONFIGURE" = "1" ]; then
  echo "== Конфиг OpenCode V2 =="
  if [ "$WRITE_CONFIG" != "1" ]; then
    print_config
  else
    python3 - "$OPENCODE_CONFIG_FILE" "$PLUGIN_ENTRY" "$HERE/.opencode/skills" <<'PY'
import json, os, shutil, sys
cfg, entry, skills = sys.argv[1], sys.argv[2], sys.argv[3]
plugin_url = "file://" + entry
data = {}
if os.path.exists(cfg):
    with open(cfg, encoding="utf-8") as f:
        data = json.load(f)
    shutil.copy2(cfg, cfg + ".bak")
plugins = data.get("plugins")
if not isinstance(plugins, list):
    plugins = []
if plugin_url not in [p.get("package", "") for p in plugins]:
    plugins.append({"package": plugin_url, "options": {}})
data["plugins"] = plugins
paths = []
sk = data.get("skills")
if isinstance(sk, dict):
    # V1-форма {"paths": [...]} -> забираем пути в нативный V2-массив
    paths = list(sk.get("paths") or [])
elif isinstance(sk, list):
    paths = list(sk)
if skills not in paths:
    paths.append(skills)
data["skills"] = paths
# V2: команду /voice регистрирует сам плагин (ctx.command.transform) —
# блок commands.voice в конфиг не пишем, чтобы не дублировать.
os.makedirs(os.path.dirname(cfg), exist_ok=True)
with open(cfg, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write("\n")
print("обновлён:", cfg, "(бэкап: %s.bak)" % cfg)
PY
    ok "конфиг обновлён (перезапустите OpenCode)"
  fi
fi

# ---------------------------------------------------------------------------
# 6. Финал: doctor
# ---------------------------------------------------------------------------
echo
echo "== Проверка установки =="
if [ -x "$HERE/doctor.sh" ]; then
  bash "$HERE/doctor.sh" || true
else
  info "doctor.sh не найден — пропускаю"
fi

echo
echo "Готово. Что дальше:"
echo "  1) если меняли конфиг — перезапустите OpenCode;"
echo "  2) сервер поднимется сам при загрузке плагина (или: python3 -u $HERE/stt-server/stt_server.py --port 8765);"
echo "  3) в TUI: /voice  (push-to-talk), /voice doctor, /voice help;"
echo "  4) для кнопки в веб-UI установите расширение из $HERE/extension (chrome://extensions → Load unpacked)."
echo "  5) после обновлений расширения: Reload в chrome://extensions + F5 вкладки (иначе тишина без ошибок);"
if [ "$DO_TTS" = "1" ]; then
echo "  6) TTS: source $HOME_DIR/env.sh (или добавьте в ~/.bashrc); в popup выберите движок «Сервер»."
fi
