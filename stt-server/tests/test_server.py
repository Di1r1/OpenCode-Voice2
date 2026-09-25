"""Hermetic pytest suite for the STT server (no microphone, no model download).

The server module is loaded directly (not via HTTP), so nothing binds a port and
transcription is monkeypatched. faster-whisper is imported lazily by the server,
so it is not required here.

Run:
    cd voice-opencode-plugin && pytest
"""

import importlib.util
import io
import json
import math
import os
import time
import wave
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("stt_server", SERVER_DIR / "stt_server.py")
srv = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(srv)


def make_wav(seconds=0.3, rate=16000, freq=0):
    """Return an in-memory mono 16-bit WAV (silence or a tone)."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        frames = bytearray()
        for i in range(int(rate * seconds)):
            val = int(3000 * math.sin(2 * math.pi * freq * i / rate)) if freq else 0
            frames += val.to_bytes(2, "little", signed=True)
        w.writeframes(bytes(frames))
    buf.seek(0)
    return buf


@pytest.fixture()
def client():
    srv.app.config.update(TESTING=True)
    return srv.app.test_client()


@pytest.fixture(autouse=True)
def _reset_state(monkeypatch):
    """No stray recorders/timers and no 5-minute delete timers during tests."""
    monkeypatch.setattr(srv, "RETAIN_SECONDS", 0.0)
    # Never write into the real recognized-text log from tests.
    monkeypatch.setenv("OPENCODE_VOICE_RECOGNIZED_LOG", "/dev/null")
    # Deterministic limits: fresh rate buckets and a free transcription semaphore.
    srv._rate_buckets.clear()
    srv._transcribe_sem = srv.threading.Semaphore(srv.MAX_CONCURRENT)
    srv._rec_proc = None
    srv._rec_file = None
    srv._cancel_watchdog()
    yield
    srv._rate_buckets.clear()
    srv._transcribe_sem = srv.threading.Semaphore(srv.MAX_CONCURRENT)
    srv._rec_proc = None
    srv._rec_file = None
    srv._cancel_watchdog()


# ---------------------------------------------------------------------------


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.get_json()
    assert body["status"] == "ok"
    assert body["backend"]
    assert body["version"] == srv.SERVER_VERSION
    assert "model" in body
    # Limits are reported so clients can align (upload size, audio length, rate).
    assert body["max_upload_mb"] == srv.MAX_UPLOAD_BYTES // (1024 * 1024)
    assert body["max_audio_seconds"] == srv.MAX_AUDIO_SECONDS
    assert body["rate_limit_per_min"] == srv.RATE_LIMIT_PER_MIN
    # Recorder depends on the host: arecord/ffmpeg/sox or None in a bare CI image.
    assert "recorder" in body
    if body["recorder"] is not None:
        assert body["recorder"] in {"arecord", "ffmpeg", "sox"}


@pytest.mark.parametrize(
    "present,expected",
    [
        ({}, None),
        ({"arecord": "/usr/bin/arecord"}, "arecord"),
        ({"ffmpeg": "/usr/bin/ffmpeg", "sox": "/usr/bin/sox"}, "ffmpeg"),
        ({"sox": "/usr/bin/sox"}, "sox"),
    ],
)
def test_record_probe_cmd(monkeypatch, present, expected):
    monkeypatch.setattr(srv.shutil, "which", lambda name: present.get(name))
    assert srv._record_probe_cmd() == expected


def test_cors_allows_local_origin(client):
    r = client.get("/health", headers={"Origin": "http://127.0.0.1:4096"})
    assert r.headers.get("Access-Control-Allow-Origin") == "http://127.0.0.1:4096"


def test_cors_rejects_foreign_origin(client):
    r = client.get("/health", headers={"Origin": "https://evil.example"})
    assert "Access-Control-Allow-Origin" not in r.headers


def test_beep_zero_freq_only_logs(client, monkeypatch):
    played = []
    monkeypatch.setattr(srv, "_play_beep", lambda *a, **k: played.append(a))
    r = client.get("/beep?freq=0")
    assert r.status_code == 200
    assert r.get_json() == {"status": "ok", "freq": 0}
    assert played == []


def test_beep_bad_freq_defaults(client, monkeypatch):
    monkeypatch.setattr(srv, "_play_beep", lambda *a, **k: None)
    r = client.get("/beep?freq=abc")
    assert r.status_code == 200
    assert r.get_json()["freq"] == 880


def test_transcribe_without_file_is_400(client):
    r = client.post("/transcribe")
    assert r.status_code == 400


def test_transcribe_returns_text(client, monkeypatch):
    monkeypatch.setattr(
        srv, "transcribe_file",
        lambda path: {"text": "привет", "language": "ru", "language_probability": 1.0},
    )
    r = client.post(
        "/transcribe",
        data={"audio": (make_wav(0.2), "t.wav")},
        content_type="multipart/form-data",
    )
    assert r.status_code == 200
    assert r.get_json()["text"] == "привет"


def test_transcribe_failure_is_500(client, monkeypatch):
    def boom(path):
        raise RuntimeError("nope")

    monkeypatch.setattr(srv, "transcribe_file", boom)
    r = client.post(
        "/transcribe",
        data={"audio": (make_wav(0.2), "t.wav")},
        content_type="multipart/form-data",
    )
    assert r.status_code == 500


def test_record_stop_without_start_is_409(client):
    assert client.post("/record/stop").status_code == 409


def test_record_status_idle(client):
    r = client.get("/record/status")
    assert r.status_code == 200
    assert r.get_json()["recording"] is False


def test_fake_record_cycle(client, monkeypatch, tmp_path):
    """FAKE_AUDIO lets the whole record pipeline run without a microphone."""
    fixture = tmp_path / "fixture.wav"
    fixture.write_bytes(make_wav(0.5).read())
    monkeypatch.setattr(srv, "FAKE_AUDIO", str(fixture))
    monkeypatch.setattr(
        srv, "transcribe_file",
        lambda path: {"text": "ok", "language": "ru", "language_probability": 1.0},
    )

    start = client.post("/record/start")
    assert start.status_code == 200
    assert start.get_json().get("fake") is True

    assert client.post("/record/start").status_code == 409
    assert client.get("/record/status").get_json()["recording"] is True

    stop = client.post("/record/stop")
    assert stop.status_code == 200
    assert stop.get_json()["text"] == "ok"

    assert client.post("/record/stop").status_code == 409


# --- Access token (OPENCODE_VOICE_TOKEN) ---


def test_health_reports_python_and_auth(client, monkeypatch):
    monkeypatch.delenv("OPENCODE_VOICE_TOKEN", raising=False)
    body = client.get("/health").get_json()
    assert body["python"]
    assert body["auth"] is False


def test_token_disabled_by_default(client, monkeypatch):
    monkeypatch.delenv("OPENCODE_VOICE_TOKEN", raising=False)
    monkeypatch.setattr(srv, "_play_beep", lambda *a, **k: None)
    assert client.get("/beep?freq=0").status_code == 200


def test_token_required_when_set(client, monkeypatch):
    monkeypatch.setenv("OPENCODE_VOICE_TOKEN", "secret")
    monkeypatch.setattr(srv, "_play_beep", lambda *a, **k: None)
    assert client.get("/beep?freq=0").status_code == 401
    assert client.get("/beep?freq=0", headers={"X-Voice-Token": "wrong"}).status_code == 401
    assert client.get("/beep?freq=0", headers={"X-Voice-Token": "secret"}).status_code == 200
    assert client.get(
        "/beep?freq=0", headers={"Authorization": "Bearer " + "secret"}
    ).status_code == 200


def test_token_exempts_health(client, monkeypatch):
    monkeypatch.setenv("OPENCODE_VOICE_TOKEN", "secret")
    r = client.get("/health")
    assert r.status_code == 200
    assert r.get_json()["auth"] is True


def test_runtime_checks_smoke(monkeypatch):
    monkeypatch.delenv("PULSE_SERVER", raising=False)
    srv._runtime_checks()  # must not raise


def test_cuda_driver_version_type():
    v = srv._cuda_driver_version()
    assert v is None or isinstance(v, str)


def test_wav_levels_silence_and_tone(tmp_path):
    silent = tmp_path / "silent.wav"
    silent.write_bytes(make_wav(0.3).getvalue())
    peak, rms = srv._wav_levels(str(silent))
    assert (peak, rms) == (0.0, 0.0)
    assert srv._is_silent(str(silent)) is True

    tone = tmp_path / "tone.wav"
    tone.write_bytes(make_wav(0.3, freq=440).getvalue())
    peak, rms = srv._wav_levels(str(tone))
    assert peak > srv.SILENCE_PEAK and rms > srv.SILENCE_RMS
    assert srv._is_silent(str(tone)) is False


def test_wav_levels_rejects_non_wav(tmp_path):
    bad = tmp_path / "bad.wav"
    bad.write_bytes(b"not a wav at all")
    assert srv._wav_levels(str(bad)) == (None, None)
    assert srv._is_silent(str(bad)) is False


def test_whispercpp_short_circuits_on_silence(tmp_path, monkeypatch):
    silent = tmp_path / "silent.wav"
    silent.write_bytes(make_wav(0.3).getvalue())
    monkeypatch.setattr(srv, "WHISPER_CPP_BIN", "/nonexistent/whisper-cli")
    monkeypatch.setattr(srv, "WHISPER_CPP_MODEL", "/nonexistent/model.bin")
    assert srv._transcribe_whispercpp(str(silent))["text"] == ""


def test_whispercpp_antihallucination_flags(tmp_path, monkeypatch):
    tone = tmp_path / "tone.wav"
    tone.write_bytes(make_wav(0.3, freq=440).getvalue())
    captured = {}

    class Result:
        returncode = 0
        stdout = "привет"
        stderr = ""

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return Result()

    monkeypatch.setattr(srv, "WHISPER_CPP_BIN", "whisper-cli")
    monkeypatch.setattr(srv, "WHISPER_CPP_MODEL", "model.bin")
    monkeypatch.setattr(srv.subprocess, "run", fake_run)
    assert srv._transcribe_whispercpp(str(tone))["text"] == "привет"
    assert "-mc" in captured["cmd"] and "0" in captured["cmd"]
    assert "-sns" in captured["cmd"]


# ---------------------------------------------------------------------------
# Recognized-text log (source tagging: button vs api)
# ---------------------------------------------------------------------------

def _fake_result(text, lang="ru"):
    return {"text": text, "language": lang, "language_probability": 1.0,
            "backend": "whispercpp", "model": "ggml-medium.bin", "duration": 1.5}


def test_recognized_log_tags_button(client, monkeypatch, tmp_path):
    log = tmp_path / "recognized.log"
    monkeypatch.setenv("OPENCODE_VOICE_RECOGNIZED_LOG", str(log))
    monkeypatch.setattr(srv, "transcribe_file", lambda path: _fake_result("привет мир"))
    r = client.post(
        "/transcribe",
        data={"audio": (make_wav(0.2), "t.wav")},
        content_type="multipart/form-data",
        headers={"X-Voice-Source": "button"},
    )
    assert r.status_code == 200
    line = log.read_text()
    assert "source=button" in line
    assert "backend=whispercpp" in line
    assert "model=ggml-medium.bin" in line
    assert 'dur=1.50s' in line
    assert 'text="привет мир"' in line


def test_recognized_log_defaults_to_api(client, monkeypatch, tmp_path):
    log = tmp_path / "recognized.log"
    monkeypatch.setenv("OPENCODE_VOICE_RECOGNIZED_LOG", str(log))
    monkeypatch.setattr(srv, "transcribe_file", lambda path: _fake_result("hi", "en"))
    client.post(
        "/transcribe",
        data={"audio": (make_wav(0.2), "t.wav")},
        content_type="multipart/form-data",
    )
    assert "source=api" in log.read_text()


def test_recognized_log_escapes_quotes_and_newlines(client, monkeypatch, tmp_path):
    log = tmp_path / "recognized.log"
    monkeypatch.setenv("OPENCODE_VOICE_RECOGNIZED_LOG", str(log))
    monkeypatch.setattr(srv, "transcribe_file", lambda path: _fake_result('a "b"\nc', "en"))
    client.post(
        "/transcribe",
        data={"audio": (make_wav(0.2), "t.wav")},
        content_type="multipart/form-data",
    )
    content = log.read_text()
    assert 'text="a \\"b\\" c"' in content
    assert content.count("\n") == 1


def test_wav_duration(tmp_path):
    good = tmp_path / "good.wav"
    good.write_bytes(make_wav(0.5).read())
    assert abs(srv._wav_duration(str(good)) - 0.5) < 0.05
    assert srv._wav_duration(str(tmp_path / "missing.wav")) == 0.0


def test_cors_allows_voice_source_header(client):
    r = client.options(
        "/transcribe",
        headers={"Origin": "http://127.0.0.1:4096",
                 "Access-Control-Request-Headers": "X-Voice-Source"},
    )
    assert "X-Voice-Source" in r.headers.get("Access-Control-Allow-Headers", "")


# ---------------------------------------------------------------------------
# Single source of truth: shared/stt-spec.json and shared/strip-cases.json
# (the same files are used by the TypeScript tests)
# ---------------------------------------------------------------------------

SHARED_DIR = Path(__file__).resolve().parents[2] / "shared"


def _shared(name):
    return json.loads((SHARED_DIR / name).read_text(encoding="utf-8"))


def test_strip_non_speech_matches_shared_cases():
    cases = _shared("strip-cases.json")
    assert cases, "shared/strip-cases.json is empty"
    for case in cases:
        assert srv._strip_non_speech(case["in"]) == case["out"], case["label"]


def test_clean_for_speech_matches_shared_cases():
    cases = _shared("tts-cases.json")
    assert cases, "shared/tts-cases.json is empty"
    for case in cases:
        out = srv._clean_for_speech(case["in"], read_code=bool(case.get("readCode")))
        assert out == case["out"], case["label"]


def test_shared_spec_is_loaded_by_server():
    spec = _shared("stt-spec.json")
    assert srv.SPEC["nonSpeechKeywords"] == spec["nonSpeechKeywords"]
    assert srv.SPEC["nonSpeechSymbols"] == spec["nonSpeechSymbols"]
    assert srv.SPEC["whisperCppExtraFlags"] == spec["whisperCppExtraFlags"]
    assert srv.SPEC["defaultModelByDevice"] == spec["defaultModelByDevice"]
    assert srv.SPEC["tts"] == spec["tts"]
    assert srv.SILENCE_PEAK == spec["silence"]["peak"]
    assert srv.SILENCE_RMS == spec["silence"]["rms"]


# ---------------------------------------------------------------------------
# Portability: whisper.cpp paths and adaptive model size
# ---------------------------------------------------------------------------

def test_default_model_size_gpu_vs_cpu(monkeypatch):
    monkeypatch.delenv("WHISPER_MODEL", raising=False)
    monkeypatch.delenv("WHISPER_CPP_MODEL_SIZE", raising=False)
    monkeypatch.setattr(srv, "_cuda_available", lambda: True)
    assert srv._default_model_size() == "medium"
    monkeypatch.setattr(srv, "_cuda_available", lambda: False)
    assert srv._default_model_size() == "small"
    monkeypatch.setenv("WHISPER_CPP_MODEL_SIZE", "large")
    assert srv._default_model_size() == "large"
    monkeypatch.setenv("WHISPER_MODEL", "base")
    monkeypatch.delenv("WHISPER_CPP_MODEL_SIZE", raising=False)
    assert srv._default_model_size() == "base"


def test_whisper_dir_honors_env(monkeypatch):
    monkeypatch.setenv("OPENCODE_VOICE_HOME", "/data/ovi")
    monkeypatch.delenv("OPENCODE_VOICE_WHISPER_DIR", raising=False)
    assert srv._whisper_dir() == "/data/ovi/whisper"
    monkeypatch.setenv("OPENCODE_VOICE_WHISPER_DIR", "/opt/whisper")
    assert srv._whisper_dir() == "/opt/whisper"


def test_cuda_lib_dirs_discovers_versioned(tmp_path, monkeypatch):
    versioned = tmp_path / "cuda-12.9" / "lib64"
    versioned.mkdir(parents=True)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("CUDA_HOME", str(tmp_path / "cuda-home"))
    (tmp_path / "cuda-home" / "lib64").mkdir(parents=True)
    dirs = srv._cuda_lib_dirs()
    assert str(versioned) in dirs
    assert str(tmp_path / "cuda-home" / "lib64") in dirs


def test_cuda_available_can_be_disabled(monkeypatch):
    monkeypatch.setenv("OPENCODE_VOICE_CUDA", "0")
    assert srv._cuda_available() is False


def test_whisper_bin_and_model_resolution(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENCODE_VOICE_WHISPER_DIR", str(tmp_path))
    monkeypatch.delenv("WHISPER_CPP_BIN", raising=False)
    cli = tmp_path / "bin" / "whisper-cli"
    cli.parent.mkdir(parents=True)
    cli.write_text("")
    assert srv._whisper_bin() == str(cli)

    monkeypatch.delenv("WHISPER_CPP_MODEL", raising=False)
    monkeypatch.setenv("WHISPER_CPP_MODEL_SIZE", "small")
    assert srv._whisper_model() == str(tmp_path / "ggml-small.bin")
    monkeypatch.setenv("WHISPER_CPP_MODEL", "/m/ggml-medium.bin")
    assert srv._whisper_model() == "/m/ggml-medium.bin"


# ---------------------------------------------------------------------------
# Overload protection: upload size, audio duration, concurrency, timeout,
# rate limiting, origin guard, periodic purge
# ---------------------------------------------------------------------------

def test_upload_too_large_is_413(client, monkeypatch):
    monkeypatch.setitem(srv.app.config, "MAX_CONTENT_LENGTH", 1024)
    big = make_wav(0.5).read()          # ~16 KB
    r = client.post(
        "/transcribe",
        data={"audio": (io.BytesIO(big), "big.wav")},
        content_type="multipart/form-data",
    )
    assert r.status_code == 413
    assert "too large" in r.get_json()["error"]


def test_audio_too_long_is_400(client, monkeypatch):
    monkeypatch.setattr(srv, "_audio_duration", lambda path: 9999.0)
    monkeypatch.setattr(srv, "transcribe_file", lambda path: {"text": "x"})
    r = client.post(
        "/transcribe",
        data={"audio": (make_wav(0.2), "t.wav")},
        content_type="multipart/form-data",
    )
    assert r.status_code == 400
    assert "too long" in r.get_json()["error"]


def test_transcribe_busy_is_429(client, monkeypatch):
    assert srv._transcribe_sem.acquire(blocking=False)   # займём единственный слот
    try:
        r = client.post(
            "/transcribe",
            data={"audio": (make_wav(0.2), "t.wav")},
            content_type="multipart/form-data",
        )
        assert r.status_code == 429
        assert "busy" in r.get_json()["error"]
    finally:
        srv._transcribe_sem.release()


def test_transcribe_timeout_is_504(client, monkeypatch):
    monkeypatch.setattr(srv, "TRANSCRIBE_TIMEOUT", 0.05)

    def slow(path):
        time.sleep(0.4)
        return {"text": "late"}

    monkeypatch.setattr(srv, "transcribe_file", slow)
    r = client.post(
        "/transcribe",
        data={"audio": (make_wav(0.2), "t.wav")},
        content_type="multipart/form-data",
    )
    assert r.status_code == 504
    assert "timed out" in r.get_json()["error"]
    time.sleep(0.5)   # дать воркеру освободить семафор


def test_rate_limit_is_429(client, monkeypatch):
    monkeypatch.setattr(srv, "RATE_LIMIT_PER_MIN", 1)
    monkeypatch.setattr(srv, "_play_beep", lambda *a, **k: None)
    assert client.get("/beep?freq=0").status_code == 200
    r = client.get("/beep?freq=0")
    assert r.status_code == 429
    assert r.headers.get("Retry-After")


def test_foreign_origin_post_is_403(client, monkeypatch):
    monkeypatch.setattr(srv, "_play_beep", lambda *a, **k: None)
    r = client.post("/beep?freq=0", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    ok = client.post("/beep?freq=0", headers={"Origin": "http://127.0.0.1:4096"})
    assert ok.status_code == 200


def test_purge_removes_stale_but_keeps_beeps(tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "TMP_DIR", str(tmp_path))
    monkeypatch.setattr(srv, "RETAIN_SECONDS", 60.0)
    stale = tmp_path / "voice-old.wav"
    fresh = tmp_path / "voice-new.wav"
    beep = tmp_path / "beep-880-120.wav"
    tts = tmp_path / "tts-abcdef.wav"
    for p in (stale, fresh, beep, tts):
        p.write_bytes(b"x")
    old = time.time() - 3600
    os.utime(stale, (old, old))
    os.utime(beep, (old, old))
    os.utime(tts, (old, old))
    srv._purge_old_files()
    assert not stale.exists()
    assert fresh.exists()
    assert beep.exists()
    assert tts.exists()  # кэш TTS живёт под LRU, а не таймером purge


# ---------------------------------------------------------------------------
# /heal — manual recovery (reset a stuck recording, optional restart)
# ---------------------------------------------------------------------------

def test_heal_ok(client):
    r = client.post("/heal")
    assert r.status_code == 200
    body = r.get_json()
    assert body["status"] == "ok"
    assert body["recording_reset"] is False
    assert body["restarting"] is False
    assert body["version"] == srv.SERVER_VERSION


def test_heal_restart_schedules_restart(client, monkeypatch):
    called = []
    monkeypatch.setattr(srv, "_restart_soon", lambda *a, **k: called.append(True))
    r = client.post("/heal?restart=1")
    assert r.status_code == 200
    assert r.get_json()["restarting"] is True
    assert called == [True]


def test_heal_resets_stuck_recording(client):
    srv._rec_proc = srv._FAKE
    srv._rec_file = "/tmp/voice-heal-test.wav"
    r = client.post("/heal")
    assert r.status_code == 200
    assert r.get_json()["recording_reset"] is True
    assert srv._rec_proc is None
    assert srv._rec_file is None


def test_server_port_from_argv(monkeypatch):
    monkeypatch.setattr(srv.sys, "argv", ["stt_server.py", "--port", "9123"])
    assert srv._server_port_from_argv() == 9123
    monkeypatch.setattr(srv.sys, "argv", ["stt_server.py", "--port=9124"])
    assert srv._server_port_from_argv() == 9124
    monkeypatch.setattr(srv.sys, "argv", ["stt_server.py"])
    monkeypatch.setenv("OPENCODE_VOICE_PORT", "9125")
    assert srv._server_port_from_argv() == 9125


def test_respawn_does_not_inherit_listening_socket(monkeypatch):
    captured = {}

    def fake_popen(args, **kwargs):
        captured["args"] = args
        captured["kwargs"] = kwargs
        return object()

    monkeypatch.setattr(srv.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(srv.sys, "argv", ["stt_server.py", "--port", "9123"])
    assert srv._respawn() is True
    assert captured["kwargs"]["close_fds"] is True  # иначе наследуется слушающий сокет
    assert captured["kwargs"]["start_new_session"] is True
    assert "9123" in captured["args"]
    assert captured["kwargs"]["stdout"] is srv.sys.stdout


# ---------------------------------------------------------------------------
# /speak — server-side TTS (fake piper; real engine is installed by setup --tts)
# ---------------------------------------------------------------------------

def _fake_piper(tmp_path):
    """Stub piper: <bin> <out.wav>, reads text on stdin, writes a tiny WAV."""
    script = tmp_path / "fake-piper"
    script.write_text(
        "#!/usr/bin/env python3\n"
        "import sys, wave\n"
        "out = sys.argv[1]\n"
        "data = sys.stdin.buffer.read()\n"
        "open(out + '.in', 'wb').write(data)\n"
        "with wave.open(out, 'wb') as w:\n"
        "    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)\n"
        "    w.writeframes(b'\\x00\\x00' * 160)\n",
        encoding="utf-8",
    )
    script.chmod(0o755)
    return script


@pytest.fixture(autouse=True)
def _reset_tts(monkeypatch, tmp_path):
    monkeypatch.setattr(srv, "TTS_ENABLED", False)
    monkeypatch.setattr(srv, "TTS_ENGINE", "piper")
    monkeypatch.setattr(srv, "TTS_VOICE", "test-voice")
    monkeypatch.setattr(srv, "TTS_MAX_CHARS", 300)
    monkeypatch.setattr(srv, "TTS_CACHE_MAX_MB", 64)
    monkeypatch.delenv("OPENCODE_VOICE_TTS_BIN", raising=False)
    # Герметичность: на машинах с setup.sh --tts каталог голосов по умолчанию
    # не пуст, и whitelist отбивал бы тестовый test-voice с 400. Подменяем его
    # пустым каталогом (тесты со своим каталогом переопределяют следом).
    hermetic_voices = tmp_path / "hermetic-voices"
    hermetic_voices.mkdir(exist_ok=True)
    monkeypatch.setenv("OPENCODE_VOICE_TTS_VOICES_DIR", str(hermetic_voices))
    # Never write into the real TTS log from tests.
    monkeypatch.setenv("OPENCODE_VOICE_TTS_LOG", "/dev/null")
    srv._tts_sem = srv.threading.Semaphore(1)
    with srv._tts_cache_lock:
        srv._tts_cache.clear()
        srv._tts_cache_bytes = 0
    yield


def _enable_tts(monkeypatch, tmp_path):
    fake = _fake_piper(tmp_path)
    monkeypatch.setattr(srv, "TTS_ENABLED", True)
    monkeypatch.setattr(srv, "TMP_DIR", str(tmp_path))
    monkeypatch.setenv("OPENCODE_VOICE_TTS_BIN", str(fake))
    return fake


def test_speak_disabled_is_501(client):
    assert client.post("/speak", json={"text": "привет"}).status_code == 501


def test_speak_unavailable_is_501(client, monkeypatch, tmp_path):
    monkeypatch.setattr(srv, "TTS_ENABLED", True)
    monkeypatch.setenv("OPENCODE_VOICE_TTS_BIN", str(tmp_path / "missing-piper"))
    assert client.post("/speak", json={"text": "привет"}).status_code == 501


def test_speak_returns_wav(client, monkeypatch, tmp_path):
    _enable_tts(monkeypatch, tmp_path)
    r = client.post("/speak", json={"text": "**Привет**, мир!"})
    assert r.status_code == 200
    assert r.mimetype == "audio/wav"
    assert r.data[:4] == b"RIFF"
    assert len(r.data) > 44


def test_speak_requires_text(client, monkeypatch, tmp_path):
    _enable_tts(monkeypatch, tmp_path)
    assert client.post("/speak", json={}).status_code == 400
    assert client.post("/speak", json={"text": "   "}).status_code == 400
    assert client.post("/speak", json={"text": "https://example.com"}).status_code == 400


def test_speak_token_required(client, monkeypatch, tmp_path):
    _enable_tts(monkeypatch, tmp_path)
    monkeypatch.setenv("OPENCODE_VOICE_TOKEN", "s3cret")
    assert client.post("/speak", json={"text": "привет"}).status_code == 401
    ok = client.post("/speak", json={"text": "привет"}, headers={"X-Voice-Token": "s3cret"})
    assert ok.status_code == 200


def test_speak_too_long_is_413(client, monkeypatch, tmp_path):
    _enable_tts(monkeypatch, tmp_path)
    monkeypatch.setattr(srv, "TTS_MAX_CHARS", 10)
    assert client.post("/speak", json={"text": "слово " * 50}).status_code == 413


def test_speak_busy_is_429(client, monkeypatch, tmp_path):
    _enable_tts(monkeypatch, tmp_path)
    assert srv._tts_sem.acquire(blocking=False)
    try:
        r = client.post("/speak", json={"text": "привет"})
        assert r.status_code == 429
        assert "busy" in r.get_json()["error"]
    finally:
        srv._tts_sem.release()


def test_speak_cache_hit(client, monkeypatch, tmp_path):
    _enable_tts(monkeypatch, tmp_path)
    calls = {"n": 0}

    def fake_synth(text, voice, rate, out):
        calls["n"] += 1
        with wave.open(out, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(b"\x00\x00" * 160)
        return True, None

    monkeypatch.setattr(srv, "_tts_synthesize", fake_synth)
    assert client.post("/speak", json={"text": "одинаковый"}).status_code == 200
    assert client.post("/speak", json={"text": "одинаковый"}).status_code == 200
    assert calls["n"] == 1


def test_speak_unknown_voice_is_400(client, monkeypatch, tmp_path):
    _enable_tts(monkeypatch, tmp_path)
    voices = tmp_path / "voices"
    voices.mkdir()
    (voices / "ru_RU-test-medium.onnx").write_bytes(b"x")
    monkeypatch.setenv("OPENCODE_VOICE_TTS_VOICES_DIR", str(voices))
    assert client.post("/speak", json={"text": "привет", "voice": "evil"}).status_code == 400
    ok = client.post("/speak", json={"text": "привет", "voice": "ru_RU-test-medium"})
    assert ok.status_code == 200


def test_speak_no_shell_injection(client, monkeypatch, tmp_path):
    _enable_tts(monkeypatch, tmp_path)
    sentinel = tmp_path / "pwned"
    r = client.post("/speak", json={"text": f"привет; $(touch {sentinel})"})
    assert r.status_code == 200
    assert not sentinel.exists()


def test_brief_sentences_include_errors():
    assert srv._brief_sentences("Всё хорошо. Произошла ошибка X. Дальше.", 1) == \
        "Всё хорошо. Произошла ошибка X."
    assert srv._brief_sentences("A. B. C.", 2) == "A. B."


def test_health_reports_tts(client, monkeypatch, tmp_path):
    _enable_tts(monkeypatch, tmp_path)
    body = client.get("/health").get_json()
    assert body["tts"]["enabled"] is True
    assert body["tts"]["engine"] == "piper"
    assert body["tts"]["available"] is True


def test_voices_lists_catalog(client, monkeypatch, tmp_path):
    voices = tmp_path / "voices"
    voices.mkdir()
    (voices / "ru_RU-b-medium.onnx").write_bytes(b"x")
    (voices / "ru_RU-a-medium.onnx").write_bytes(b"x")
    (voices / "notes.txt").write_bytes(b"not a voice")
    monkeypatch.setenv("OPENCODE_VOICE_TTS_VOICES_DIR", str(voices))
    body = client.get("/voices").get_json()
    assert body["status"] == "ok"
    assert body["voices"] == ["ru_RU-a-medium", "ru_RU-b-medium"]
    assert body["engine"] == "piper"


def test_voices_empty_without_dir(client, monkeypatch, tmp_path):
    monkeypatch.setenv("OPENCODE_VOICE_TTS_VOICES_DIR", str(tmp_path / "no-such-dir"))
    body = client.get("/voices").get_json()
    assert body["status"] == "ok"
    assert body["voices"] == []


def test_voices_requires_token(client, monkeypatch, tmp_path):
    _enable_tts(monkeypatch, tmp_path)
    monkeypatch.setenv("OPENCODE_VOICE_TOKEN", "s3cret")
    assert client.get("/voices").status_code == 401
    ok = client.get("/voices", headers={"X-Voice-Token": "s3cret"})
    assert ok.status_code == 200
    assert ok.get_json()["status"] == "ok"
