#!/usr/bin/env python3
# OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
"""
OpenCode Voice STT Server
Flask + faster-whisper for local speech-to-text.

Recording is done SERVER-SIDE via WSL PulseAudio (arecord/ffmpeg) because
the Windows browser cannot see the WSL microphone. This mirrors /voice behaviour.

Run:
    export PULSE_SERVER=/mnt/wslg/PulseServer
    python3 stt_server.py
"""

import array
import hashlib
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import wave
import logging
from collections import OrderedDict
from pathlib import Path
from flask import Flask, request, jsonify, send_file

# --- Единый источник истины с TypeScript: voice-opencode-plugin/shared/stt-spec.json ---
_SPEC_PATH = Path(__file__).resolve().parents[1] / "shared" / "stt-spec.json"
_FALLBACK_SPEC = {
    "nonSpeechKeywords": [
        "музык", "music", "аплодисмент", "applause", "смех", "laugh", "тишин", "silence",
        "шум", "noise", "звук", "sound", "свист", "whistl", "кашел", "кашл", "cough",
        "вздох", "sigh", "шёпот", "шепот", "whisper", "неразборчив", "inaudible", "пауза",
        "paus", "гудок", "сигнал", "signal", "звон", "ring", "стук", "knock", "хлопок",
        "clap", "помех", "static", "инструментал", "instrumental", "мужской голос", "женский голос",
    ],
    "nonSpeechSymbols": "♪♫♬♩♭♮#",
    "silence": {"peak": 700, "rms": 80},
    "whisperCppExtraFlags": ["-mc", "0", "-sns"],
    "defaultModelByDevice": {"gpu": "medium", "cpu": "small"},
    "tts": {
        "engine": "piper",
        "voice": "ru_RU-irina-medium",
        "rate": 1.0,
        "maxChars": 300,
        "briefSentences": 2,
        "mode": "brief",
        "lang": "auto",
        "localOnly": True,
        "maxSeconds": 60,
    },
}


def _load_spec() -> dict:
    """Читает shared/stt-spec.json (единый с плагином); при ошибке — фолбэк."""
    try:
        with open(_SPEC_PATH, encoding="utf-8") as f:
            data = json.load(f)
        merged = dict(_FALLBACK_SPEC)
        merged.update({k: v for k, v in data.items() if not k.startswith("$")})
        return merged
    except Exception:
        return dict(_FALLBACK_SPEC)


SPEC = _load_spec()

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)


# CORS: разрешаем только локальные origin (OpenCode UI, расширение), а не "*".
# Иначе любая веб-страница в браузере могла бы дёргать локальный сервер.
_ALLOWED_ORIGIN = re.compile(
    r"^(https?://(127\.0\.0\.1|localhost|10\.\d+\.\d+\.\d+|"
    r"172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)(:\d+)?"
    r"|chrome-extension://[a-p]{32})$",
    re.IGNORECASE,
)


@app.after_request
def _cors(resp):
    origin = request.headers.get("Origin", "")
    if origin and _ALLOWED_ORIGIN.match(origin):
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Vary"] = "Origin"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Voice-Token, Authorization, X-Voice-Source"
    return resp


# Опциональный токен доступа. Если OPENCODE_VOICE_TOKEN задан, все запросы кроме
# /health и CORS-preflight должны присылать заголовок X-Voice-Token (или Bearer).
# Пустой токен = поведение как раньше (сервер слушает только localhost).
def _auth_token() -> str:
    return os.getenv("OPENCODE_VOICE_TOKEN", "")


@app.before_request
def _check_token():
    token = _auth_token()
    if token and request.method != "OPTIONS" and request.path != "/health":
        got = request.headers.get("X-Voice-Token", "")
        if not got:
            auth = request.headers.get("Authorization", "")
            if auth.startswith("Bearer "):
                got = auth[7:]
        if got != token:
            return jsonify({"status": "error", "error": "unauthorized: bad or missing token"}), 401
    # Origin-проверка для изменяющих запросов: кросс-сайтовые «простые» POST
    # (без preflight) отсекаем здесь, а не только политикой CORS в браузере.
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("Origin", "")
        if origin and not _ALLOWED_ORIGIN.match(origin):
            return jsonify({"status": "error", "error": "forbidden origin"}), 403
    return None


# Auto-detect WSLg PulseAudio socket (needed for server-side recording)
if not os.getenv("PULSE_SERVER") and os.path.exists("/mnt/wslg/PulseServer"):
    os.environ["PULSE_SERVER"] = "unix:/mnt/wslg/PulseServer"

# Аудио пишем в RAM (tmpfs), а не на диск; удаляем через RETAIN_SECONDS секунд.
TMP_DIR = os.getenv("OPENCODE_VOICE_TMP_DIR", "/dev/shm/opencode-voice")
try:
    RETAIN_SECONDS = float(os.getenv("OPENCODE_VOICE_RETAIN_SECONDS", "300"))
except ValueError:
    RETAIN_SECONDS = 300.0

# ---------------------------------------------------------------------------
# Защита от перегрузки (P0): лимит размера загрузки, длительности, параллельности,
# rate-limit и периодическая чистка RAM-каталога.
# ---------------------------------------------------------------------------
MAX_UPLOAD_MB = int(os.getenv("OPENCODE_VOICE_MAX_UPLOAD_MB", "25"))
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES
MAX_AUDIO_SECONDS = int(os.getenv("OPENCODE_VOICE_MAX_AUDIO_SECONDS", "300"))
MAX_CONCURRENT = max(1, int(os.getenv("OPENCODE_VOICE_MAX_CONCURRENT", "1")))
RATE_LIMIT_PER_MIN = int(os.getenv("OPENCODE_VOICE_RATE_LIMIT", "60"))
try:
    TRANSCRIBE_TIMEOUT = float(os.getenv("OPENCODE_VOICE_TRANSCRIBE_TIMEOUT", "300"))
except ValueError:
    TRANSCRIBE_TIMEOUT = 300.0
try:
    PURGE_INTERVAL = float(os.getenv("OPENCODE_VOICE_PURGE_INTERVAL", "600"))
except ValueError:
    PURGE_INTERVAL = 600.0

_transcribe_sem = threading.Semaphore(MAX_CONCURRENT)
_rate_lock = threading.Lock()
_rate_buckets: dict = {}

# ---------------------------------------------------------------------------
# TTS: серверный синтез (аддитивно; по умолчанию выключен). Движок по умолчанию —
# Piper (офлайн). Звук в web-UI проигрывает браузер: POST /speak -> audio/wav;
# серверный _play_file нужен только TUI (этап F) и как фолбэк.
# ---------------------------------------------------------------------------
_TTS_SPEC = SPEC.get("tts", {}) or {}


def _env_flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in ("0", "false", "no", "off", "")


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


TTS_ENABLED = _env_flag("OPENCODE_VOICE_TTS", False)
TTS_ENGINE = os.getenv("OPENCODE_VOICE_TTS_ENGINE", str(_TTS_SPEC.get("engine", "piper"))).strip().lower()
TTS_VOICE = os.getenv("OPENCODE_VOICE_TTS_VOICE", str(_TTS_SPEC.get("voice", ""))).strip()
TTS_RATE = _env_float("OPENCODE_VOICE_TTS_RATE", float(_TTS_SPEC.get("rate", 1.0)))
TTS_MAX_CHARS = _env_int("OPENCODE_VOICE_TTS_MAX_CHARS", int(_TTS_SPEC.get("maxChars", 300)))
TTS_BRIEF_SENTENCES = _env_int(
    "OPENCODE_VOICE_TTS_BRIEF_SENTENCES", int(_TTS_SPEC.get("briefSentences", 2))
)
TTS_MODE = os.getenv("OPENCODE_VOICE_TTS_MODE", str(_TTS_SPEC.get("mode", "brief"))).strip().lower()
TTS_LANG = os.getenv("OPENCODE_VOICE_TTS_LANG", str(_TTS_SPEC.get("lang", "auto"))).strip()
TTS_CACHE_MAX_MB = _env_int("OPENCODE_VOICE_TTS_CACHE_MB", 64)
TTS_TIMEOUT = _env_float("OPENCODE_VOICE_TTS_TIMEOUT", 60.0)

_tts_sem = threading.Semaphore(max(1, _env_int("OPENCODE_VOICE_TTS_MAX_CONCURRENT", 1)))
_tts_cache: "OrderedDict[str, tuple]" = OrderedDict()  # key -> (path, size)
_tts_cache_bytes = 0
_tts_cache_lock = threading.Lock()

_TTS_ERROR_RE = re.compile(
    r"ошибк|error|fail|failed|не удалось|предупрежд|warn|exception|traceback|panic|fatal",
    re.IGNORECASE,
)


def _tts_home() -> str:
    return os.path.join(_whisper_home(), "tts")


def _tts_piper_bin() -> str:
    # OPENCODE_VOICE_TTS_BIN — явный бинарь (используется и тестами как fake-piper).
    return (
        os.getenv("OPENCODE_VOICE_TTS_BIN")
        or os.getenv("OPENCODE_VOICE_TTS_PIPER_BIN")
        or shutil.which("piper")
        or os.path.join(_tts_home(), "piper", "piper")
    )


def _tts_voices_dir() -> str:
    return os.getenv("OPENCODE_VOICE_TTS_VOICES_DIR", os.path.join(_tts_home(), "voices"))


def _tts_allowed_voices() -> list:
    """Whitelist голосов: имена *.onnx в каталоге (никаких путей из запроса)."""
    try:
        return sorted(p[:-5] for p in os.listdir(_tts_voices_dir()) if p.endswith(".onnx"))
    except Exception:
        return []


def _tts_voice_file(voice: str) -> str:
    return os.path.join(_tts_voices_dir(), voice + ".onnx")


def _tts_available() -> bool:
    if not TTS_ENABLED or TTS_ENGINE != "piper":
        return False
    binp = _tts_piper_bin()
    if os.getenv("OPENCODE_VOICE_TTS_BIN"):
        return os.path.exists(binp)  # fake/тестовый бинарь — без каталога голосов
    if not (os.path.exists(binp) or shutil.which(binp)):
        return False
    if TTS_VOICE and os.path.exists(_tts_voice_file(TTS_VOICE)):
        return True
    return bool(_tts_allowed_voices())


def _tts_status() -> dict:
    return {
        "enabled": TTS_ENABLED,
        "engine": TTS_ENGINE,
        "voice": TTS_VOICE,
        "available": _tts_available(),
        "cache_mb": TTS_CACHE_MAX_MB,
        "max_chars": TTS_MAX_CHARS,
    }


def _log_tts(event: str, extra: str = ""):
    try:
        log_file = os.getenv("OPENCODE_VOICE_TTS_LOG", "/tmp/opencode/voice-tts.log")
        with open(log_file, "a") as f:
            f.write(
                f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {event} {extra}\n"
            )
    except Exception:
        pass


def _brief_sentences(text: str, n: int, include_errors: bool = True) -> str:
    """«Кратко»: первые N предложений + предложения с ошибками (решение §10.3)."""
    sentences = [s.strip() for s in re.findall(r"[^.!?…]+[.!?…]*", text) if s.strip()]
    if not sentences:
        return ""
    take = sentences[: max(1, n)]
    if include_errors:
        for s in sentences:
            if _TTS_ERROR_RE.search(s) and s not in take:
                take.append(s)
    return " ".join(take)


def _tts_cache_key(text: str, voice: str, rate: float, mode: str) -> str:
    raw = f"{voice}|{rate:.3f}|{mode}|{text}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:24]


def _tts_cache_get(key: str):
    global _tts_cache_bytes
    with _tts_cache_lock:
        item = _tts_cache.get(key)
        if not item:
            return None
        path, size = item
        if not os.path.exists(path):
            _tts_cache.pop(key, None)
            _tts_cache_bytes -= size
            return None
        _tts_cache.move_to_end(key)
        return path


def _tts_cache_put(key: str, path: str):
    global _tts_cache_bytes
    try:
        size = os.path.getsize(path)
    except Exception:
        return
    limit = max(0, TTS_CACHE_MAX_MB) * 1024 * 1024
    with _tts_cache_lock:
        old = _tts_cache.pop(key, None)
        if old:
            _tts_cache_bytes -= old[1]
        _tts_cache[key] = (path, size)
        _tts_cache_bytes += size
        while _tts_cache_bytes > limit and _tts_cache:
            _, (evicted, esize) = _tts_cache.popitem(last=False)
            _tts_cache_bytes -= esize
            try:
                if os.path.exists(evicted):
                    os.unlink(evicted)
            except Exception:
                pass


def _tts_synthesize(text: str, voice: str, rate: float, out_path: str):
    """Синтез WAV. Текст передаётся на stdin (без shell). (ok, error)."""
    try:
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
    except Exception:
        pass
    override = os.getenv("OPENCODE_VOICE_TTS_BIN", "")
    if override:
        cmd = [override, out_path]  # контракт fake-piper: <bin> <out.wav>, текст на stdin
    else:
        cmd = [_tts_piper_bin(), "--model", _tts_voice_file(voice), "--output_file", out_path]
        if abs(rate - 1.0) > 1e-6:
            cmd += ["--length_scale", f"{1.0 / rate:.3f}"]
    try:
        proc = subprocess.run(
            cmd, input=text.encode("utf-8"), capture_output=True, timeout=TTS_TIMEOUT, check=False,
        )
    except Exception as e:  # noqa: BLE001
        return False, f"synthesis failed: {e}"
    if proc.returncode != 0 or not os.path.exists(out_path):
        err = (proc.stderr or b"").decode("utf-8", "replace").strip()[:200]
        return False, (err or f"synthesis failed (exit {proc.returncode})")
    return True, None


def _rate_limited(kind: str) -> bool:
    """Простой token bucket на IP+эндпоинт (RATE_LIMIT_PER_MIN запросов в минуту)."""
    if RATE_LIMIT_PER_MIN <= 0:
        return False
    key = f"{request.remote_addr or '?'}:{kind}"
    now = time.time()
    with _rate_lock:
        tokens, last = _rate_buckets.get(key, (float(RATE_LIMIT_PER_MIN), now))
        tokens = min(float(RATE_LIMIT_PER_MIN), tokens + (now - last) * (RATE_LIMIT_PER_MIN / 60.0))
        if tokens < 1.0:
            _rate_buckets[key] = (tokens, now)
            return True
        _rate_buckets[key] = (tokens - 1.0, now)
        return False


def _too_many():
    resp = jsonify({"status": "error", "error": "too many requests, slow down"})
    resp.status_code = 429
    resp.headers["Retry-After"] = "2"
    return resp


@app.errorhandler(413)
def _too_large(_e):
    return jsonify({
        "status": "error",
        "error": f"audio file too large (max {MAX_UPLOAD_MB} MB)",
    }), 413


def _audio_duration(path: str):
    """Длительность аудио в секундах (WAV — напрямую, иначе ffprobe). None если неизвестно."""
    dur = _wav_duration(path)
    if dur > 0:
        return dur
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", path],
            capture_output=True, text=True, timeout=10,
        )
        if out.returncode == 0 and out.stdout.strip():
            return float(out.stdout.strip())
    except Exception:
        pass
    return None


def _transcribe_guarded(path: str):
    """Транскрибация под семафором и с таймаутом.

    Возвращает (result, None) либо (None, (json_body, status_code)).
    Семафор держится до фактического завершения воркера (не пile-up при таймауте).
    """
    if not _transcribe_sem.acquire(blocking=False):
        return None, ({"status": "error", "error": "server busy: another transcription is running"}, 429)
    box: dict = {"result": None, "error": None}
    done = threading.Event()

    def worker():
        try:
            box["result"] = transcribe_file(path)
        except Exception as e:  # noqa: BLE001 - пробрасываем наружу как 500
            box["error"] = e
        finally:
            done.set()
            _transcribe_sem.release()

    threading.Thread(target=worker, daemon=True).start()
    if not done.wait(TRANSCRIBE_TIMEOUT):
        return None, ({"status": "error",
                       "error": f"transcription timed out after {TRANSCRIBE_TIMEOUT:.0f}s"}, 504)
    if box["error"] is not None:
        logger.error("Transcription failed", exc_info=box["error"])
        return None, ({"status": "error", "error": str(box["error"])}, 500)
    return box["result"], None


def _purge_loop():
    """Периодически чистит RAM-каталог (таймеры удаления не переживают сбои)."""
    interval = PURGE_INTERVAL if PURGE_INTERVAL > 0 else 600.0
    while True:
        time.sleep(interval)
        _purge_old_files()

# --- Портируемость: пути к whisper.cpp и CUDA находятся автоматически --------
# Всё настраивается через env, дефолты считаются от OPENCODE_VOICE_HOME
# (по умолчанию ~/.local/share/opencode-voice). Версия CUDA не зашита: каталоги
# cuda-* ищутся в /usr/local, /opt, ~ и в каталоге установки whisper.

def _whisper_home() -> str:
    return os.getenv("OPENCODE_VOICE_HOME") or os.path.expanduser("~/.local/share/opencode-voice")


def _whisper_dir() -> str:
    return os.getenv("OPENCODE_VOICE_WHISPER_DIR") or os.path.join(_whisper_home(), "whisper")


def _cuda_lib_dirs() -> list:
    """Существующие каталоги с CUDA-рантаймом/драйвером (без привязки к версии)."""
    out = []

    def add(p):
        if p and os.path.isdir(p) and p not in out:
            out.append(p)

    add("/usr/lib/wsl/lib")
    for base in ("/usr/local", "/opt", os.path.expanduser("~"), _whisper_dir()):
        if not os.path.isdir(base):
            continue
        add(os.path.join(base, "cuda", "lib64"))
        try:
            entries = os.listdir(base)
        except OSError:
            entries = []
        for name in entries:
            if name.startswith("cuda-"):
                add(os.path.join(base, name, "lib64"))
    for env_name in ("CUDA_HOME", "CUDA_PATH"):
        value = os.getenv(env_name)
        if value:
            add(os.path.join(value, "lib64"))
    return out


def _cuda_available() -> bool:
    """Есть ли CUDA-драйвер/рантайм (libcuda/libcudart) или CUDA явно отключена."""
    if os.getenv("OPENCODE_VOICE_CUDA", "1").lower() in ("0", "false", "no", "off"):
        return False
    candidates = [
        "/usr/lib/wsl/lib/libcuda.so.1",
        "/usr/lib/wsl/lib/libcuda.so",
        "/usr/lib/x86_64-linux-gnu/libcuda.so.1",
    ]
    for d in _cuda_lib_dirs():
        candidates += [os.path.join(d, "libcuda.so.1"), os.path.join(d, "libcuda.so"),
                       os.path.join(d, "libcudart.so")]
    return any(os.path.exists(p) for p in candidates)


def _default_model_size() -> str:
    """Размер модели: явный env, иначе значение из spec (GPU/CPU)."""
    return (os.getenv("WHISPER_CPP_MODEL_SIZE") or os.getenv("WHISPER_MODEL")
            or (SPEC["defaultModelByDevice"]["gpu"] if _cuda_available()
                else SPEC["defaultModelByDevice"]["cpu"]))


def _whisper_bin() -> str:
    """Бинарь whisper.cpp: env, затем типовые места установки."""
    candidates = [
        os.getenv("WHISPER_CPP_BIN"),
        os.path.join(_whisper_dir(), "bin", "whisper-cli"),
        os.path.join(_whisper_dir(), "bin", "whisper-cpp"),
        os.path.join(_whisper_dir(), "bin", "main"),
        os.path.join(_whisper_dir(), "build", "bin", "whisper-cli"),
    ]
    for c in candidates:
        if c and os.path.exists(c):
            return c
    return os.getenv("WHISPER_CPP_BIN") or os.path.join(_whisper_dir(), "bin", "whisper-cli")


def _whisper_model() -> str:
    """Путь к модели: явный WHISPER_CPP_MODEL или <whisperDir>/ggml-<size>.bin."""
    return os.getenv("WHISPER_CPP_MODEL") or os.path.join(
        _whisper_dir(), f"ggml-{_default_model_size()}.bin")


# Model will be loaded in main()
model = None
MODEL_SIZE = _default_model_size()
DEVICE = "cpu"
COMPUTE_TYPE = "int8"
SERVER_VERSION = "0.4.1"

# Параметры faster-whisper для ленивой загрузки при откате whisper.cpp → CPU.
FT_MODEL = _default_model_size()
FT_DEVICE = "cpu"
FT_COMPUTE = "int8"

# Подсказка для пунктуации/контекста (bias для Whisper). По умолчанию пусто:
# жёсткий русский prompt ухудшал распознавание отдельных слов (проверка → прайберка).
INITIAL_PROMPT = os.getenv("WHISPER_INITIAL_PROMPT", "")
LANGUAGE = os.getenv("OPENCODE_VOICE_LANGUAGE", "") or None  # "" → авто

# Качество авто-определения языка (используется только когда LANGUAGE is None).
# Больше сегментов → точнее, но чуть медленнее; threshold отсекает неуверенные.
LANG_DETECT_SEGMENTS = int(os.getenv("WHISPER_LANG_DETECT_SEGMENTS", "3"))
LANG_DETECT_THRESHOLD = float(os.getenv("WHISPER_LANG_DETECT_THRESHOLD", "0.6"))

# Скорость распознавания: beam_size=1 (greedy) заметно быстрее beam=5.
BEAM_SIZE = int(os.getenv("WHISPER_BEAM_SIZE", "1"))
VAD_FILTER = os.getenv("WHISPER_VAD", "1").lower() not in ("0", "false", "no", "off", "")

# Отладка: если задан каталог — сохранять туда каждый записанный/принятый WAV.
KEEP_AUDIO_DIR = os.getenv("OPENCODE_VOICE_KEEP_AUDIO", "")

# Бэкенд распознавания: "whispercpp" (GPU через whisper.cpp CLI) или
# "faster-whisper" (CPU). Пусто = авто: whispercpp, если найден бинарник и модель.
STT_BACKEND = os.getenv("OPENCODE_VOICE_STT_BACKEND", "").lower()
WHISPER_CPP_BIN = _whisper_bin()
WHISPER_CPP_MODEL = _whisper_model()
WHISPER_CPP_LIB_DIR = os.getenv("WHISPER_CPP_LIB_DIR") or os.path.dirname(WHISPER_CPP_BIN)
# Дополнительные каталоги для LD_LIBRARY_PATH (CUDA-рантайм + драйвер WSL) —
# находятся автоматически; можно переопределить через WHISPER_CPP_EXTRA_LIBS.
WHISPER_CPP_EXTRA_LIBS = os.getenv(
    "WHISPER_CPP_EXTRA_LIBS",
    ":".join(_cuda_lib_dirs()),
)

# Recording state
_rec_lock = threading.Lock()
_rec_proc = None
_rec_file = None
_rec_start = 0.0
_rec_timer = None

SAMPLE_RATE = 16000
CHANNELS = 1
MAX_SECONDS = int(os.getenv("OPENCODE_VOICE_MAX_SECONDS", "300"))
# Сколько ждать реальных данных от рекордера при старте (заголовок WAV пишется
# сразу, поэтому одного роста файла недостаточно — см. _wait_for_audio).
START_AUDIO_TIMEOUT = float(os.getenv("OPENCODE_VOICE_START_AUDIO_TIMEOUT", "2.5"))
MIN_AUDIO_BYTES = 4000

# Авто-восстановление аудиоканала WSLg при «молчащем» источнике (мёртвый
# канал audin / зависший PulseAudio). Перезапускает weston+pulseaudio через
# interop; GUI WSLg при этом перезапускается. Отключается:
#   OPENCODE_VOICE_AUTO_RECOVER=0
AUTO_RECOVER = os.getenv("OPENCODE_VOICE_AUTO_RECOVER", "1").lower() not in (
    "0", "false", "no", "off", "",
)
RECOVER_COOLDOWN = float(os.getenv("OPENCODE_VOICE_AUTO_RECOVER_COOLDOWN", "90"))
WSL_EXE = os.getenv("WSL_EXE", "/mnt/c/Windows/System32/wsl.exe")
_last_recover = 0.0

# Test mode: use a fixture WAV instead of a real microphone.
# Позволяет проверить весь пайплайн без аудиоустройства.
FAKE_AUDIO = os.getenv("OPENCODE_VOICE_FAKE_AUDIO", "")
_FAKE = object()  # sentinel for "recording" in fake mode


def load_model(size, device, compute_type):
    global model, MODEL_SIZE, DEVICE, COMPUTE_TYPE
    MODEL_SIZE = size
    DEVICE = device
    COMPUTE_TYPE = compute_type
    # Ленивый импорт: в GPU-режиме (whisper.cpp) faster-whisper не обязателен.
    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        raise RuntimeError(
            "faster-whisper не установлен (pip install faster-whisper). "
            "Для GPU-режима он не нужен — используется whisper.cpp."
        ) from e
    logger.info(f"Loading faster-whisper model: {MODEL_SIZE} on {DEVICE} ({COMPUTE_TYPE})")
    model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
    logger.info("Model loaded successfully")


# ---------------------------------------------------------------------------
# Transcription
# ---------------------------------------------------------------------------

def whispercpp_available() -> bool:
    return os.path.exists(WHISPER_CPP_BIN) and os.path.exists(WHISPER_CPP_MODEL)


def _is_wav(path: str) -> bool:
    try:
        with open(path, "rb") as f:
            head = f.read(12)
        return head[:4] == b"RIFF" and head[8:12] == b"WAVE"
    except Exception:
        return False


def _new_wav_path() -> str:
    """Путь для аудио в RAM-каталоге (tmpfs), а не на диске."""
    try:
        os.makedirs(TMP_DIR, exist_ok=True)
    except Exception:
        pass
    return tempfile.mktemp(suffix=".wav", dir=TMP_DIR)


def _schedule_delete(path: str):
    """Удалить файл через RETAIN_SECONDS (для отладки/тестов файлы живут 5 минут)."""
    if os.getenv("OPENCODE_VOICE_KEEP_AUDIO"):
        return
    if RETAIN_SECONDS <= 0:
        return

    def _rm():
        try:
            if path and os.path.exists(path):
                os.unlink(path)
        except Exception:
            pass

    t = threading.Timer(RETAIN_SECONDS, _rm)
    t.daemon = True
    t.start()


def _purge_old_files():
    """Удалить аудио старше RETAIN_SECONDS (после перезапуска сервера)."""
    try:
        now = time.time()
        for name in os.listdir(TMP_DIR):
            p = os.path.join(TMP_DIR, name)
            # beep-/tts- файлы живут под своими таймерами/кэшем
            if name.startswith("beep-") or name.startswith("tts-"):
                continue
            try:
                if os.path.isfile(p) and (now - os.path.getmtime(p)) > RETAIN_SECONDS:
                    os.unlink(p)
            except Exception:
                pass
    except Exception:
        pass


def _beep_wav(freq: int, ms: int = 120, rate: int = 44100) -> str:
    """Сгенерировать (и закэшировать) WAV-сигнал в RAM-каталоге."""
    path = os.path.join(TMP_DIR, f"beep-{freq}-{ms}.wav")
    if os.path.exists(path):
        return path
    try:
        import math
        import struct
        import wave

        os.makedirs(TMP_DIR, exist_ok=True)
        n = int(rate * ms / 1000)
        fade = max(1, int(rate * 0.005))
        frames = bytearray()
        for i in range(n):
            env = min(1.0, i / fade, (n - i) / (fade * 2))
            val = int(12000 * math.sin(2 * math.pi * freq * i / rate) * env)
            frames += struct.pack("<h", val)
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(bytes(frames))
    except Exception as e:
        logger.warning(f"beep wav failed: {e}")
    return path


def _play_file(path: str):
    """Проиграть WAV через PulseAudio (WSL) — best-effort. Нужен TUI/фолбэку."""
    if not path or not os.path.exists(path):
        return
    for cmd in (["aplay", "-D", "pulse", "-q", path],
                ["paplay", path],
                ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", path]):
        if shutil.which(cmd[0]):
            try:
                subprocess.run(cmd, timeout=5, check=False,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                return
            except Exception:
                pass


def _play_beep(freq: int = 880, ms: int = 120):
    """Проиграть сигнал через PulseAudio (WSL) — best-effort."""
    try:
        _play_file(_beep_wav(freq, ms))
    except Exception:
        pass


def _to_wav(path: str):
    """Конвертация в 16 кГц моно WAV через ffmpeg. Возвращает (путь, временный?)."""
    if _is_wav(path) or not shutil.which("ffmpeg"):
        return path, False
    out = _new_wav_path()
    proc = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", path,
         "-ar", str(SAMPLE_RATE), "-ac", "1", out],
        capture_output=True, text=True,
    )
    if proc.returncode != 0 or not os.path.exists(out):
        logger.warning(f"ffmpeg convert failed: {(proc.stderr or '').strip()[:200]}")
        return path, False
    _schedule_delete(out)
    return out, True


# Служебные пометки Whisper на музыке/шуме: [музыка], (смех), ♪, *music* и т.п.
# Источник списка — shared/stt-spec.json (тот же, что в src/lib/text.ts).
_NON_SPEECH = re.compile(
    "^(?:" + "|".join(re.escape(k) for k in SPEC["nonSpeechKeywords"]) + ")",
    re.IGNORECASE,
)
_SYMBOLS_RE = re.compile("[" + re.escape(SPEC["nonSpeechSymbols"]) + "]+")


def _strip_non_speech(text: str) -> str:
    """Вырезает служебные пометки ([музыка], (смех), ♪ …) из результата распознавания."""
    t = re.sub(r"\[[^\]]*\]", " ", text)          # [музыка], [Music]
    t = re.sub(r"\*[^*]*\*", " ", t)              # *music*
    t = re.sub(
        r"\(([^)]*)\)",
        lambda m: " " if _NON_SPEECH.match(m.group(1).strip()) else m.group(0),
        t,
    )                                             # (смех), но не (то есть)
    t = _SYMBOLS_RE.sub(" ", t)                   # ноты (из shared/stt-spec.json)
    t = re.sub(r"\s{2,}", " ", t)
    t = re.sub(r"\s+([,.!?;:])", r"\1", t)
    return t.strip()


# --- TTS: чистка markdown перед озвучкой (паритет с cleanForSpeech в src/lib/text.ts) ---
_CODE_PLACEHOLDER = "…код…"
_FENCE_RE = re.compile(r"```[\s\S]*?```")
_HTML_COMMENT_RE = re.compile(r"<!--[\s\S]*?-->")
_IMAGE_RE = re.compile(r"!\[(?:[^\]]*)\]\([^)]*\)")
_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_AUTOLINK_RE = re.compile(r"<(?:https?://[^>\s]+)>")
_URL_RE = re.compile(r"https?://[^\s)]+")
_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+", re.MULTILINE)
_HR_RE = re.compile(r"^\s{0,3}([-*_])(?:\s*\1){2,}\s*$", re.MULTILINE)
_QUOTE_RE = re.compile(r"^\s{0,3}>\s?", re.MULTILINE)
_LIST_RE = re.compile(r"^\s{0,3}(?:[-*+]|\d+[.)])\s+", re.MULTILINE)
_TABLE_SEP_RE = re.compile(r"^\s*\|?[:\s|-]+\|?\s*$", re.MULTILINE)
_STRIKE_RE = re.compile(r"~~([^~]+)~~")
_BOLD_RE = re.compile(r"\*\*([^*]+)\*\*")
_BOLD_U_RE = re.compile(r"__([^_]+)__")
_ITALIC_RE = re.compile(r"\*([^*]+)\*")
_ITALIC_U_RE = re.compile(r"(^|[\s(])_([^_]+)_(?=[\s).,!?]|$)")


def _clean_for_speech(text: str, read_code: bool = False) -> str:
    """Готовит markdown-ответ ассистента к озвучке (без разметки/кода/ссылок).

    Паритет с cleanForSpeech() в src/lib/text.ts: те же шаги и порядок;
    кейсы — shared/tts-cases.json (тот же файл читает npm test).
    """
    t = text.replace("\r\n", "\n").replace("\r", "\n")
    t = _HTML_COMMENT_RE.sub(" ", t)

    def _fence(m):
        block = m.group(0)
        if not read_code:
            return " " + _CODE_PLACEHOLDER + " "
        inner = re.sub(r"^```[^\n]*\n?", "", block)
        inner = re.sub(r"```$", "", inner)
        return " " + inner + " "

    t = _FENCE_RE.sub(_fence, t)
    t = _IMAGE_RE.sub(" ", t)
    t = _LINK_RE.sub(r"\1", t)
    t = _AUTOLINK_RE.sub(" ", t)
    t = _URL_RE.sub(" ", t)
    t = _HEADING_RE.sub("", t)
    t = _HR_RE.sub(" ", t)
    t = _QUOTE_RE.sub("", t)
    t = _LIST_RE.sub("", t)
    t = _TABLE_SEP_RE.sub("", t)
    t = t.replace("|", " ")
    t = _STRIKE_RE.sub(r"\1", t)
    t = _BOLD_RE.sub(r"\1", t)
    t = _BOLD_U_RE.sub(r"\1", t)
    t = _ITALIC_RE.sub(r"\1", t)
    t = _ITALIC_U_RE.sub(r"\1\2", t)
    t = t.replace("`", "")
    t = re.sub(r"\s+", " ", t)
    return t.strip()


SILENCE_PEAK = int(os.getenv("OPENCODE_VOICE_SILENCE_PEAK", str(SPEC["silence"]["peak"])))
SILENCE_RMS = int(os.getenv("OPENCODE_VOICE_SILENCE_RMS", str(SPEC["silence"]["rms"])))


def _wav_levels(path: str) -> tuple:
    """(peak, rms) по PCM16-данным WAV; (None, None), если это не 16-бит PCM."""
    try:
        with wave.open(path, "rb") as w:
            if w.getsampwidth() != 2:
                return None, None
            raw = w.readframes(w.getnframes())
        samples = array.array("h")
        samples.frombytes(raw)
        if not samples:
            return 0.0, 0.0
        peak = max(abs(x) for x in samples)
        rms = (sum(x * x for x in samples) / len(samples)) ** 0.5
        return float(peak), float(rms)
    except Exception:
        return None, None


def _is_silent(path: str) -> bool:
    """Тишина/шум: не гоняем Whisper — на тишине он галлюцинирует."""
    peak, rms = _wav_levels(path)
    if peak is None:
        return False
    silent = peak < SILENCE_PEAK and rms < SILENCE_RMS
    logger.info(f"audio levels: peak={peak:.0f} rms={rms:.0f} -> silent={silent}")
    return silent


def _wav_duration(path: str) -> float:
    """Длительность WAV в секундах (0.0, если не удалось)."""
    try:
        with wave.open(path, "rb") as w:
            rate = w.getframerate() or 1
            return w.getnframes() / rate
    except Exception:
        return 0.0


def _log_recognized(source: str, result: dict, path: str):
    """Единый лог распознанного текста: видно, откуда пришёл текст (source=button|api|...)."""
    try:
        text = str(result.get("text", ""))
        esc = text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")
        dur = result.get("duration")
        if dur is None:
            dur = _wav_duration(path)
        log_file = os.getenv("OPENCODE_VOICE_RECOGNIZED_LOG", "/tmp/opencode/voice-recognized.log")
        with open(log_file, "a") as f:
            f.write(
                f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} source={source} "
                f"backend={result.get('backend', '?')} model={result.get('model', '?')} "
                f"lang={result.get('language', '?')} dur={float(dur):.2f}s text=\"{esc}\"\n"
            )
    except Exception:
        pass


def _transcribe_whispercpp(path: str) -> dict:
    lang = LANGUAGE or "auto"
    env = dict(os.environ)
    libs = ":".join(d for d in (WHISPER_CPP_LIB_DIR, WHISPER_CPP_EXTRA_LIBS) if d)
    if env.get("LD_LIBRARY_PATH"):
        libs = f"{libs}:{env['LD_LIBRARY_PATH']}"
    env["LD_LIBRARY_PATH"] = libs
    # whisper.cpp/miniaudio не читает WebM/Opus (это путь браузерного микрофона),
    # поэтому не-WAV вход конвертируем через ffmpeg.
    audio, is_temp = _to_wav(path)
    try:
        meta = {"backend": "whispercpp", "model": os.path.basename(WHISPER_CPP_MODEL),
                "duration": _wav_duration(audio)}
        if _is_silent(audio):
            logger.info("Transcribed via whisper.cpp: речи нет (тишина) — пропускаю")
            return {"text": "", "language": lang, "language_probability": 1.0, **meta}
        # -mc 0 (без переноса контекста) и -sns (без не-речевых токенов) снижают галлюцинации.
        cmd = [WHISPER_CPP_BIN, "-m", WHISPER_CPP_MODEL, "-f", audio, "-l", lang,
               "-nt", "-np", *SPEC["whisperCppExtraFlags"]]
        logger.info(f"whisper.cpp -> {' '.join(cmd)}")
        start = time.time()
        proc = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=180)
        if proc.returncode != 0:
            raise RuntimeError(f"whisper.cpp failed: {(proc.stderr or '').strip()[:300]}")
        text = _strip_non_speech(proc.stdout.strip())
        logger.info(f"Transcribed via whisper.cpp ({lang}, {time.time() - start:.1f}s): {text[:120]}")
        return {"text": text, "language": lang, "language_probability": 1.0, **meta}
    finally:
        if is_temp:
            try:
                os.unlink(audio)
            except Exception:
                pass


def transcribe_file(path: str) -> dict:
    if STT_BACKEND == "whispercpp":
        try:
            return _transcribe_whispercpp(path)
        except Exception as e:
            # GPU недоступна / CLI не запустился — автоматический откат на CPU.
            logger.warning(
                "whisper.cpp недоступен (%s) — откат на faster-whisper (CPU)",
                str(e)[:200],
            )
            try:
                _ensure_faster_whisper()
            except Exception as fe:
                # faster-whisper не установлен — не скрываем исходную ошибку GPU.
                logger.error("faster-whisper недоступен для отката: %s", fe)
                raise e
            return _transcribe_faster_whisper(path)
    return _transcribe_faster_whisper(path)


def _ensure_faster_whisper():
    """Ленивая загрузка CPU-модели (используется при откате с whisper.cpp)."""
    global model
    if model is None:
        load_model(FT_MODEL, FT_DEVICE, FT_COMPUTE)
    return model


def _transcribe_faster_whisper(path: str) -> dict:
    if _is_silent(path):
        logger.info("Transcribed: речи нет (тишина) — пропускаю")
        return {"text": "", "language": LANGUAGE or "auto", "language_probability": 0.0,
                "backend": "faster-whisper", "model": MODEL_SIZE, "duration": _wav_duration(path)}
    segments, info = model.transcribe(
        path,
        language=LANGUAGE,          # None → авто, либо ru/en из env
        beam_size=BEAM_SIZE,
        vad_filter=VAD_FILTER,
        vad_parameters=dict(min_silence_duration_ms=300),
        initial_prompt=INITIAL_PROMPT or None,
        condition_on_previous_text=False,
        temperature=0.0,
        language_detection_segments=LANG_DETECT_SEGMENTS,
        language_detection_threshold=LANG_DETECT_THRESHOLD,
    )
    text = _strip_non_speech(" ".join(seg.text for seg in segments).strip())
    logger.info(f"Transcribed ({info.language}, {info.language_probability:.2f}): {text[:120]}")
    return {"text": text, "language": info.language, "language_probability": info.language_probability,
            "backend": "faster-whisper", "model": MODEL_SIZE, "duration": _wav_duration(path)}


# ---------------------------------------------------------------------------
# Server-side recording (WSL PulseAudio)
# ---------------------------------------------------------------------------

def _record_cmd(out_path: str):
    """Pick a recording backend available in this environment."""
    if shutil.which("arecord"):
        return ["arecord", "-D", "pulse", "-f", "S16_LE",
                "-r", str(SAMPLE_RATE), "-c", str(CHANNELS),
                "-t", "wav", "-d", str(MAX_SECONDS), out_path]
    if shutil.which("ffmpeg"):
        return ["ffmpeg", "-y", "-f", "pulse", "-ar", str(SAMPLE_RATE),
                "-ac", str(CHANNELS), "-t", str(MAX_SECONDS), out_path]
    if shutil.which("sox"):
        return ["sox", "-r", str(SAMPLE_RATE), "-c", str(CHANNELS),
                "-t", "wav", out_path, "trim", "0", str(MAX_SECONDS)]
    return None


def _record_probe_cmd():
    """Return which recorder would be used (without a real output path)."""
    if shutil.which("arecord"):
        return "arecord"
    if shutil.which("ffmpeg"):
        return "ffmpeg"
    if shutil.which("sox"):
        return "sox"
    return None


def _friendly_rec_error(raw: str) -> str:
    """Преобразовать сырую ошибку рекордера в понятную подсказку."""
    low = raw.lower()
    if "connection refused" in low or "unable to connect" in low:
        return (
            "Нет доступа к микрофону: PulseAudio не отвечает. "
            "WSLg передаёт звук через канал audin — похоже, он отвалился. "
            "Проверь доступ приложения к микрофону в Windows "
            "(Параметры → Конфиденциальность → Микрофон); в RDP-сессии включи "
            "«Запись с этого компьютера». Если не помогло — перезапусти WSL: "
            "wsl --shutdown. "
            "Проверка: arecord -D pulse -f cd -d 2 /tmp/t.wav"
        )
    if "no such file" in low or "cannot open" in low:
        return "Рекордер не может открыть устройство. Проверь PULSE_SERVER и наличие источника."
    return raw


def _kill_recorder(proc):
    """Жёстко завершить процесс рекордера (вместе с группой)."""
    if proc is None or proc is _FAKE:
        return
    try:
        if proc.poll() is None:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception:
                proc.kill()
        try:
            proc.wait(timeout=2)
        except Exception:
            pass
    except Exception:
        pass


def _wait_for_audio(path: str, proc, timeout: float):
    """Дождаться, пока рекордер реально начнёт писать звук.

    arecord/ffmpeg создают WAV-заголовок сразу, даже если данные не идут,
    поэтому проверки «файл существует и не пустой» недостаточно. Ждём, пока
    размер превысит MIN_AUDIO_BYTES, либо истечения timeout. Возвращает
    (ok, last_size).
    """
    deadline = time.time() + max(0.0, timeout)
    size = 0
    while True:
        if proc.poll() is not None:
            return False, size
        try:
            size = os.path.getsize(path)
        except OSError:
            size = 0
        if size >= MIN_AUDIO_BYTES:
            return True, size
        if time.time() >= deadline:
            return False, size
        time.sleep(0.1)


def _cancel_watchdog():
    global _rec_timer
    if _rec_timer is not None:
        _rec_timer.cancel()
        _rec_timer = None


def _watchdog_fire(expected_proc):
    """Рекордер не завершился сам за отведённое время — убить и сбросить состояние.

    `arecord -d` через pulse-плагин ALSA ненадёжен и может быть проигнорирован,
    поэтому длительность записи страхуется таймером на стороне сервера.
    """
    global _rec_proc, _rec_file, _rec_timer
    with _rec_lock:
        if _rec_proc is None or _rec_proc is not expected_proc:
            return
        logger.warning(
            "Watchdog: запись превысила лимит %ss — останавливаю принудительно",
            MAX_SECONDS + 5,
        )
        proc = _rec_proc
        path = _rec_file
        _rec_proc = None
        _rec_file = None
        _rec_timer = None
    _kill_recorder(proc)
    _schedule_delete(path)


def _arm_watchdog(proc):
    global _rec_timer
    _cancel_watchdog()
    _rec_timer = threading.Timer(MAX_SECONDS + 5, _watchdog_fire, args=(proc,))
    _rec_timer.daemon = True
    _rec_timer.start()


def _keep_audio(path, tag="rec"):
    """Отладочно сохранить WAV в KEEP_AUDIO_DIR (если задан)."""
    if not KEEP_AUDIO_DIR or not path or not os.path.exists(path):
        return
    try:
        os.makedirs(KEEP_AUDIO_DIR, exist_ok=True)
        dst = os.path.join(KEEP_AUDIO_DIR, f"{tag}-{time.strftime('%Y%m%d-%H%M%S')}.wav")
        shutil.copyfile(path, dst)
        logger.info(f"kept audio -> {dst}")
    except Exception as e:
        logger.warning(f"keep audio failed: {e}")


def _wslg_restart():
    """Пересоздать аудиоканал WSLg: перезапустить weston и pulseaudio.

    Делается через interop в системном дистрибутиве WSLg (WSLGd поднимает
    процессы заново). GUI WSLg (Wayland-окна) при этом перезапустится.
    Возвращает True, если команды удалось выполнить (без гарантии, что
    микрофон заработал).
    """
    if not os.path.exists(WSL_EXE):
        logger.warning("Авто-восстановление: не найден %s", WSL_EXE)
        return False
    try:
        subprocess.run(
            [WSL_EXE, "--system", "-e", "sh", "-lc", "pkill -9 -x weston"],
            timeout=30, check=False,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        time.sleep(float(os.getenv("WSLG_RESTART_WESTON_WAIT", "8")))
        subprocess.run(
            [WSL_EXE, "--system", "-e", "sh", "-lc", "pkill -9 -x pulseaudio"],
            timeout=30, check=False,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        time.sleep(float(os.getenv("WSLG_RESTART_PULSE_WAIT", "5")))
        # Вернуть default source на микрофон (иначе запись уйдёт в monitor).
        try:
            subprocess.run(
                ["pactl", "set-default-source",
                 os.getenv("OPENCODE_VOICE_SOURCE", "RDPSource")],
                timeout=15, check=False,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        except Exception:
            pass
        return True
    except Exception as e:
        logger.warning("Авто-восстановление WSLg не удалось: %s", e)
        return False


def _reap_if_done():
    """Если рекордер уже завершился сам (лимит -d, ошибка) — освободить состояние.

    Вызывается под _rec_lock. Без этого сервер навсегда застревает в
    «recording» и отвечает 409 на все последующие /record/start.
    """
    global _rec_proc, _rec_file
    if _rec_proc is not None and _rec_proc is not _FAKE and _rec_proc.poll() is not None:
        logger.info("Recorder процесс завершился сам — сбрасываю состояние записи")
        try:
            _rec_proc.wait(timeout=2)  # reap zombie
        except Exception:
            pass
        if _rec_file and os.path.exists(_rec_file):
            try:
                os.unlink(_rec_file)
            except Exception:
                pass
        _rec_proc = None
        _rec_file = None
        _cancel_watchdog()
        return True
    return False


@app.route("/record/start", methods=["POST"])
def record_start():
    _log_request("record/start")
    global _rec_proc, _rec_file, _rec_start, _last_recover
    with _rec_lock:
        _reap_if_done()
        if _rec_proc is not None:
            return jsonify({"error": "already recording", "recording": True}), 409

        _rec_start = time.time()

        # Fake-audio test mode: no real microphone needed
        if FAKE_AUDIO:
            if not os.path.exists(FAKE_AUDIO):
                return jsonify({"error": f"FAKE_AUDIO not found: {FAKE_AUDIO}"}), 500
            _rec_proc = _FAKE
            logger.info(f"[fake] Recording started (fixture: {FAKE_AUDIO})")
            return jsonify({"status": "recording", "fake": True, "since": _rec_start})

        last_size = 0
        for attempt in range(2):
            _rec_file = _new_wav_path()
            cmd = _record_cmd(_rec_file)
            if cmd is None:
                _rec_file = None
                return jsonify({"error": "no recorder (arecord/ffmpeg/sox) found"}), 500

            logger.info(f"Recording -> {' '.join(cmd)}")

            try:
                rec_env = dict(os.environ)
                # Явный микрофон: иначе default-source может съехать на RDPSink.monitor
                # после обрыва канала audin, и запись поймает системный звук.
                rec_env["PULSE_SOURCE"] = os.getenv("OPENCODE_VOICE_SOURCE", "RDPSource")
                _rec_proc = subprocess.Popen(
                    cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                    preexec_fn=os.setsid, env=rec_env,
                )
            except Exception as e:
                _rec_proc = None
                _rec_file = None
                return jsonify({"error": str(e)}), 500

            # Дожидаемся реальных данных, а не только WAV-заголовка. Если рекордер
            # подключился, но звук не идёт (мёртвый канал audin / зависший
            # PulseAudio) — один раз пробуем пересоздать аудиоканал и повторить.
            ok, last_size = _wait_for_audio(_rec_file, _rec_proc, START_AUDIO_TIMEOUT)
            if ok:
                _arm_watchdog(_rec_proc)
                return jsonify({"status": "recording", "since": _rec_start})

            died = _rec_proc.poll() is not None
            raw = ""
            if died:
                try:
                    raw = (_rec_proc.stderr.read() or b"").decode("utf-8", "replace").strip()
                except Exception:
                    pass

            can_recover = (
                attempt == 0
                and AUTO_RECOVER
                and not died
                and not raw
                and (time.time() - _last_recover) >= RECOVER_COOLDOWN
            )
            _kill_recorder(_rec_proc)
            _rec_proc = None
            _rec_file = None

            if can_recover:
                logger.warning(
                    "Аудиоисточник молчит — пересоздаю WSLg-аудиоканал "
                    "(weston+pulseaudio) и повторяю попытку"
                )
                _last_recover = time.time()
                if _wslg_restart():
                    continue

            if raw:
                msg = _friendly_rec_error(raw)
            elif died:
                msg = (
                    "Микрофон недоступен (PulseAudio не отвечает). "
                    "Проверь PULSE_SERVER=/mnt/wslg/PulseServer и что WSLg-аудио активно."
                )
            else:
                msg = (
                    "Аудиоисточник молчит: рекордер подключился, но данных нет "
                    f"(получено {last_size} байт). WSLg передаёт микрофон через канал "
                    "audin — похоже, он отвалился. Проверь доступ приложения к "
                    "микрофону в Windows (Параметры → Конфиденциальность → "
                    "Микрофон); в RDP-сессии включи «Запись с этого компьютера». "
                    "Если не помогло — перезапусти WSL: wsl --shutdown. "
                    "Проверка: arecord -D pulse -f cd -d 2 /tmp/t.wav"
                )
            logger.error(f"Recorder failed: {msg}")
            return jsonify({"error": msg}), 500

    return jsonify({"error": "recorder failed"}), 500


@app.route("/record/status", methods=["GET"])
def record_status():
    with _rec_lock:
        _reap_if_done()
        if _rec_proc is None:
            return jsonify({"recording": False})
        return jsonify({"recording": True, "seconds": round(time.time() - _rec_start, 1)})


@app.route("/record/stop", methods=["POST"])
def record_stop():
    global _rec_proc, _rec_file, _rec_start
    if _rate_limited("record"):
        return _too_many()
    with _rec_lock:
        if _rec_proc is None:
            return jsonify({"error": "not recording"}), 409

        proc = _rec_proc
        path = _rec_file
        _rec_proc = None
        _rec_file = None
        _cancel_watchdog()

        # Fake-audio test mode: copy the fixture, skip the real process
        if proc is _FAKE:
            path = _new_wav_path()
            shutil.copyfile(FAKE_AUDIO, path)
            logger.info(f"[fake] Recording stopped, using fixture -> {path}")
        elif proc.poll() is not None:
            # Рекордер уже завершился сам — просто забираем его файл
            logger.info("Recorder завершился сам; транскрибирую оставшийся файл")
        else:
            # Stop the recorder gracefully so the WAV header is finalized
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGINT)
            except Exception:
                proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                except Exception:
                    proc.kill()

    if not path or not os.path.exists(path):
        return jsonify({"error": "recording file missing"}), 500

    size = os.path.getsize(path)
    logger.info(f"Recording stopped: {path} ({size} bytes)")
    _keep_audio(path, "rec")
    if size < 2000:
        _schedule_delete(path)
        return jsonify({"text": "", "warning": "recording too short"})

    source = request.headers.get("X-Voice-Source", "button")
    try:
        result, err = _transcribe_guarded(path)
        if err is not None:
            return jsonify(err[0]), err[1]
        _log_recognized(source, result, path)
        return jsonify(result)
    finally:
        _schedule_delete(path)


# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------

_restart_timer = None

# Помощник перезапуска: дожидается, пока старый сервер перестанет отвечать на
# порту, и запускает сервер заново. Позволяет подниматься за ~3-5 с, не ожидая
# watchdog плагина (до 120 с). Ждём через connect (а не bind): так корректно
# определяется живой слушатель.
_RESPAWN_HELPER = (
    "import os, socket, sys, time\n"
    "port = int(sys.argv[1]); cmd = sys.argv[2:]\n"
    "for _ in range(300):\n"
    "    s = socket.socket(); s.settimeout(0.3)\n"
    "    try:\n"
    "        s.connect(('127.0.0.1', port))\n"
    "    except OSError:\n"
    "        s.close(); break\n"
    "    s.close(); time.sleep(0.2)\n"
    "time.sleep(0.3)\n"
    "os.execv(cmd[0], cmd)\n"
)


def _server_port_from_argv() -> int:
    """Порт из sys.argv (--port N / --port=N), иначе env или 8765."""
    argv = sys.argv
    for i, a in enumerate(argv):
        if a == "--port" and i + 1 < len(argv):
            try:
                return int(argv[i + 1])
            except ValueError:
                return 8765
        if a.startswith("--port="):
            try:
                return int(a.split("=", 1)[1])
            except ValueError:
                return 8765
    try:
        return int(os.getenv("OPENCODE_VOICE_PORT", "8765") or 8765)
    except ValueError:
        return 8765


def _respawn() -> bool:
    """Отсоединённо запускает новый процесс сервера (с ожиданием порта)."""
    cmd = [sys.executable, "-u", os.path.abspath(sys.argv[0]), *sys.argv[1:]]
    subprocess.Popen(
        [sys.executable, "-c", _RESPAWN_HELPER, str(_server_port_from_argv()), *cmd],
        start_new_session=True,         # новый сеанс — переживёт наш выход
        close_fds=True,                  # НЕ наследовать слушающий сокет (иначе порт занят)
        stdout=sys.stdout, stderr=sys.stderr,  # но лог (fd 1/2) сохранить
        cwd=os.getcwd(),
    )
    return True


def _restart_self(respawned: bool = False):
    """Точка выхода процесса. Вынесена в отдельную функцию, чтобы тесты не завершали процесс."""
    if respawned:
        logger.warning("Restart requested — respawning a detached server process")
    else:
        logger.warning("Restart requested — exiting so the plugin watchdog revives the server")


def _restart_soon(delay: float = 1.5):
    """Планирует рестарт: сначала ответ /heal, потом выход процесса."""
    global _restart_timer

    def _fire():
        respawned = False
        try:
            respawned = _respawn()
        except Exception as e:  # pragma: no cover - зависит от окружения
            logger.error(f"self-respawn failed: {e}")
        _restart_self(respawned)
        os._exit(0)

    _restart_timer = threading.Timer(delay, _fire)
    _restart_timer.daemon = True
    _restart_timer.start()


@app.route("/heal", methods=["POST"])
def heal_route():
    """Сброс зависшей записи (+ рестарт процесса через ?restart=1)."""
    if _rate_limited("heal"):
        return jsonify({"error": "rate limited"}), 429

    global _rec_proc, _rec_file
    reset = False
    with _rec_lock:
        if _rec_proc is not None:
            proc = _rec_proc
            _rec_proc = None
            _rec_file = None
            _cancel_watchdog()
            try:
                if proc is not _FAKE:
                    _kill_recorder(proc)
            except Exception:
                pass
            reset = True

    try:
        _purge_old_files()
    except Exception:
        pass

    restart = str(request.args.get("restart", "")).lower() in ("1", "true", "yes", "on")
    if restart:
        _restart_soon()
    _log_request("heal", f"reset={reset} restart={restart}")
    return jsonify({
        "status": "ok",
        "recording_reset": reset,
        "restarting": restart,
        "version": SERVER_VERSION,
    })


@app.route("/health", methods=["GET"])
def health():
    # Бэкенд может быть ещё не разрешён (если main() не выполнялся) — считаем его здесь.
    backend = STT_BACKEND or ("whispercpp" if whispercpp_available() else "faster-whisper")
    return jsonify({
        "status": "ok",
        "version": SERVER_VERSION,
        "backend": backend,
        "model": MODEL_SIZE,
        "device": "cuda" if (backend == "whispercpp" and _cuda_available()) else DEVICE,
        "recorder": _record_probe_cmd(),
        "pulse_server": os.getenv("PULSE_SERVER", ""),
        "fake_audio": FAKE_AUDIO or None,
        "python": platform.python_version(),
        "auth": bool(_auth_token()),
        "max_upload_mb": MAX_UPLOAD_BYTES // (1024 * 1024),
        "max_audio_seconds": MAX_AUDIO_SECONDS,
        "rate_limit_per_min": RATE_LIMIT_PER_MIN,
        "tts": _tts_status(),
    })


def _log_request(kind: str, extra: str = ""):
    """Диагностика: кто и когда дергает сервер (авто-старт пишет в никуда)."""
    try:
        with open("/tmp/opencode/voice-requests.log", "a") as f:
            ua = (request.headers.get("User-Agent") or "")[:40]
            org = (request.headers.get("Origin") or "")[:40]
            f.write(f"{time.strftime('%H:%M:%S')} {kind} {extra} origin={org} ua={ua}\n")
    except Exception:
        pass


@app.route("/beep", methods=["GET", "POST"])
def beep_route():
    """Проиграть звуковой сигнал из WSL (тот же путь, что у /voice)."""
    if _rate_limited("beep"):
        return _too_many()
    try:
        freq = int(request.args.get("freq", "880"))
    except (TypeError, ValueError):
        freq = 880
    _log_request("beep", f"freq={freq}")
    if freq > 0:
        threading.Thread(target=_play_beep, args=(freq,), daemon=True).start()
    return jsonify({"status": "ok", "freq": freq})


@app.route("/speak", methods=["POST"])
def speak_route():
    """Синтез речи: JSON {text, voice?, rate?, mode?} -> audio/wav (играет браузер)."""
    _log_request("speak")
    if not TTS_ENABLED:
        return jsonify({"status": "error", "error": "tts disabled (set OPENCODE_VOICE_TTS=1)"}), 501
    if not _tts_available():
        return jsonify({"status": "error", "error": f"tts engine unavailable ({TTS_ENGINE})"}), 501
    if _rate_limited("speak"):
        return _too_many()

    payload = request.get_json(silent=True) or {}
    raw = payload.get("text")
    if not isinstance(raw, str) or not raw.strip():
        return jsonify({"status": "error", "error": "no text provided"}), 400

    mode = str(payload.get("mode") or TTS_MODE).strip().lower()
    voice = str(payload.get("voice") or TTS_VOICE).strip()
    try:
        rate = float(payload.get("rate", TTS_RATE))
    except (TypeError, ValueError):
        rate = TTS_RATE
    if not voice:
        return jsonify({"status": "error", "error": "no voice configured"}), 400
    allowed = _tts_allowed_voices()
    if allowed and voice not in allowed:
        return jsonify({"status": "error", "error": "unknown voice (not in catalog)"}), 400

    text = _clean_for_speech(raw)
    if mode == "brief":
        text = _brief_sentences(text, TTS_BRIEF_SENTENCES)
    if len(text) > TTS_MAX_CHARS:
        return jsonify({"status": "error",
                        "error": f"text too long ({len(text)} > {TTS_MAX_CHARS})"}), 413
    if not text:
        return jsonify({"status": "error", "error": "empty text after cleanup"}), 400

    key = _tts_cache_key(text, voice, rate, mode)
    cached = _tts_cache_get(key)
    if cached:
        _log_tts("speak", f"cache=hit voice={voice} chars={len(text)}")
        return send_file(cached, mimetype="audio/wav")

    if not _tts_sem.acquire(blocking=False):
        return jsonify({"status": "error",
                        "error": "server busy: another synthesis is running"}), 429
    try:
        out = os.path.join(TMP_DIR, f"tts-{key}.wav")
        ok, err = _tts_synthesize(text, voice, rate, out)
        if not ok:
            _log_tts("speak", f"error={err!r} voice={voice}")
            return jsonify({"status": "error", "error": err}), 500
        _tts_cache_put(key, out)
        _log_tts("speak", f"cache=miss voice={voice} chars={len(text)} rate={rate:.2f}")
        return send_file(out, mimetype="audio/wav")
    finally:
        _tts_sem.release()


@app.route("/voices", methods=["GET"])
def voices_route():
    """Каталог серверных TTS-голосов: {"status","engine","default","voices","enabled","available"}.

    Аддитивный read-only роут для popup расширения (токен — общий, через
    `_check_token`; rate-limit/лога нет — как у `/record/status`). Список виден
    и при выключенном TTS, чтобы голос можно было выбрать заранее.
    """
    return jsonify({
        "status": "ok",
        "engine": TTS_ENGINE,
        "default": TTS_VOICE,
        "voices": _tts_allowed_voices(),
        "enabled": TTS_ENABLED,
        "available": _tts_available(),
    })


@app.route("/transcribe", methods=["POST"])
def transcribe():
    _log_request("transcribe")
    if _rate_limited("transcribe"):
        return _too_many()
    if "audio" not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files["audio"]
    if audio_file.filename == "":
        return jsonify({"error": "Empty filename"}), 400

    suffix = Path(audio_file.filename).suffix or ".webm"
    try:
        os.makedirs(TMP_DIR, exist_ok=True)
    except Exception:
        pass
    with tempfile.NamedTemporaryFile(suffix=suffix, dir=TMP_DIR, delete=False) as tmp:
        audio_file.save(tmp.name)
        tmp_path = tmp.name
    _keep_audio(tmp_path, "upload")

    duration = _audio_duration(tmp_path)
    if duration is not None and duration > MAX_AUDIO_SECONDS:
        _schedule_delete(tmp_path)
        return jsonify({"status": "error",
                        "error": f"audio too long ({duration:.0f}s > {MAX_AUDIO_SECONDS}s)"}), 400

    source = request.headers.get("X-Voice-Source", "api")
    try:
        result, err = _transcribe_guarded(tmp_path)
        if err is not None:
            return jsonify(err[0]), err[1]
        _log_recognized(source, result, tmp_path)
        return jsonify(result)
    finally:
        _schedule_delete(tmp_path)


def _cuda_driver_version():
    """Версия CUDA-драйвера (cuDriverGetVersion) или None."""
    try:
        import ctypes

        for name in ("libcuda.so.1", "libcuda.so"):
            try:
                lib = ctypes.CDLL(name)
            except OSError:
                continue
            v = ctypes.c_int(0)
            if lib.cuDriverGetVersion(ctypes.byref(v)) == 0:
                return f"{v.value // 1000}.{(v.value % 1000) // 10}"
    except Exception:
        pass
    return None


def _runtime_checks():
    """Понятные сообщения о версиях и зависимостях при старте."""
    logger.info("Python %s", platform.python_version())
    if sys.version_info < (3, 9):
        logger.warning("Требуется Python 3.9+, найден %s", platform.python_version())

    if STT_BACKEND == "whispercpp":
        if not os.path.exists(WHISPER_CPP_BIN):
            logger.warning(
                "whisper.cpp CLI не найден: %s (соберите whisper.cpp или задайте WHISPER_CPP_BIN)",
                WHISPER_CPP_BIN,
            )
        if not os.path.exists(WHISPER_CPP_MODEL):
            logger.warning("Модель не найдена: %s (задайте WHISPER_CPP_MODEL)", WHISPER_CPP_MODEL)
        if _cuda_available():
            ver = _cuda_driver_version()
            logger.info("CUDA-драйвер доступен%s", f" (версия {ver})" if ver else "")
        else:
            logger.warning(
                "CUDA не найдена — whisper.cpp пойдёт на CPU (медленно). "
                "Обновите драйвер NVIDIA (R470+) или задайте OPENCODE_VOICE_DEVICE=cpu"
            )

    rec = _record_probe_cmd()
    if rec:
        logger.info("Рекордер: %s", rec)
    else:
        logger.warning("Не найден рекордер (arecord/ffmpeg/sox) — запись с микрофона недоступна")

    pulse = os.getenv("PULSE_SERVER", "")
    if pulse.startswith("unix:") and not os.path.exists(pulse[5:]):
        logger.warning("PULSE_SERVER=%s не существует — проверьте WSLg/PulseAudio", pulse)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="OpenCode Voice STT Server")
    parser.add_argument("--host", default=os.getenv("OPENCODE_VOICE_HOST", "127.0.0.1"),
                        help="Host to bind (default 127.0.0.1; use 0.0.0.0 to expose on the network)")
    parser.add_argument("--port", type=int, default=8765, help="Port to bind")
    parser.add_argument("--model", default=_default_model_size(), help="Whisper model size (tiny, base, small, medium, large)")
    parser.add_argument("--device", default="cpu", help="Device (cpu, cuda)")
    parser.add_argument("--compute-type", default="int8", help="Compute type (int8, float16, float32)")
    args = parser.parse_args()

    # Убрать зависшие рекордеры прошлых запусков (держат микрофон).
    # OPENCODE_VOICE_STALE_CLEANUP=0 — не трогать посторонние процессы (тесты, параллельный запуск).
    if os.getenv("OPENCODE_VOICE_STALE_CLEANUP", "1").lower() not in ("0", "false", "no", "off"):
        for pat in ("voice-ptt-", "arecord -D pulse", "ffmpeg -y -f alsa"):
            try:
                subprocess.run(["pkill", "-9", "-f", pat], check=False)
            except Exception:
                pass

    if not STT_BACKEND:
        STT_BACKEND = "whispercpp" if whispercpp_available() else "faster-whisper"

    # OPENCODE_VOICE_DEVICE=cpu — принудительно CPU (faster-whisper).
    if os.getenv("OPENCODE_VOICE_DEVICE", "").lower() == "cpu":
        STT_BACKEND = "faster-whisper"

    # CPU-параметры для ленивого отката whisper.cpp → faster-whisper.
    FT_MODEL = args.model
    FT_DEVICE = args.device
    FT_COMPUTE = args.compute_type

    if STT_BACKEND == "whispercpp":
        MODEL_SIZE = os.path.basename(WHISPER_CPP_MODEL)
        cuda = "CUDA" if _cuda_available() else "CPU"
        logger.info(f"STT backend: whisper.cpp ({cuda}), model={WHISPER_CPP_MODEL}")
        logger.info(f"CPU fallback: faster-whisper {FT_MODEL} ({FT_DEVICE}/{FT_COMPUTE})")
    else:
        load_model(args.model, args.device, args.compute_type)
        logger.info(f"STT backend: faster-whisper ({args.device}/{args.compute_type})")

    _runtime_checks()
    if TTS_ENABLED:
        logger.info(
            "TTS: engine=%s voice=%s available=%s max_chars=%d cache=%dMB",
            TTS_ENGINE, TTS_VOICE or "(unset)", _tts_available(), TTS_MAX_CHARS, TTS_CACHE_MAX_MB,
        )

    logger.info(f"Starting server on {args.host}:{args.port}")
    logger.info(f"PULSE_SERVER={os.getenv('PULSE_SERVER', '(not set)')}")
    logger.info(
        f"Language: {LANGUAGE or 'auto'} "
        f"(detect segments={LANG_DETECT_SEGMENTS}, threshold={LANG_DETECT_THRESHOLD})"
    )
    logger.info(f"STT: model={MODEL_SIZE} beam={BEAM_SIZE} vad={VAD_FILTER}")
    logger.info(
        f"Limits: upload<={MAX_UPLOAD_MB}MB audio<={MAX_AUDIO_SECONDS}s "
        f"concurrent={MAX_CONCURRENT} rate={RATE_LIMIT_PER_MIN}/min timeout={TRANSCRIBE_TIMEOUT:.0f}s"
    )
    _purge_old_files()
    threading.Thread(target=_purge_loop, daemon=True).start()
    # При перезапуске (/heal) порт может освобождаться не мгновенно — пробуем снова.
    for _attempt in range(40):
        try:
            app.run(host=args.host, port=args.port, threaded=True)
            break
        except SystemExit:
            logger.warning("порт ещё занят — повторная попытка через 0.5 с")
            time.sleep(0.5)
