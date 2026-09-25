// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
// Озвучка ответов ассистента (аддитивный, по умолчанию выключенный слой).
//
// Источник текста — same-origin API web-UI: живой поток GET /api/event (SSE,
// без токена; конверт {type,durable,location,data}); снимок — root GET /session/{id}/message.
// Запускается из content.js через OpenCodeVoiceTTS.start({ getPhase, toast, log }).
//
// Чистые хелперы отдаются в globalThis.OpenCodeVoiceTTS — их гоняет test/tts.test.mjs
// через node:vm (кросс-паритет с src/lib/text.ts по shared/tts-cases.json).

(function () {
  "use strict";

  // ------------------------------------------------------------------ helpers

  var CODE_PLACEHOLDER = "…код…";
  var HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
  var FENCE_RE = /```[\s\S]*?```/g;
  var IMAGE_RE = /!\[(?:[^\]]*)\]\([^)]*\)/g;
  var LINK_RE = /\[([^\]]+)\]\([^)]*\)/g;
  var AUTOLINK_RE = /<(?:https?:\/\/[^>\s]+)>/g;
  var URL_RE = /https?:\/\/[^\s)]+/g;
  var HEADING_RE = /^\s{0,3}#{1,6}\s+/gm;
  var HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/gm;
  var QUOTE_RE = /^\s{0,3}>\s?/gm;
  var LIST_RE = /^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm;
  var TABLE_SEP_RE = /^\s*\|?[:\s|-]+\|?\s*$/gm;
  var STRIKE_RE = /~~([^~]+)~~/g;
  var BOLD_RE = /\*\*([^*]+)\*\*/g;
  var BOLD_U_RE = /__([^_]+)__/g;
  var ITALIC_RE = /\*([^*]+)\*/g;
  var ITALIC_U_RE = /(^|[\s(])_([^_]+)_(?=[\s).,!?]|$)/g;
  var ERROR_RE = /ошибк|error|fail|failed|не удалось|предупрежд|warn|exception|traceback|panic|fatal/i;

  // Копия cleanForSpeech из src/lib/text.ts (сборщика нет). Паритет проверяет
  // test/tts.test.mjs: те же shared/tts-cases.json гоняются через обе реализации.
  function cleanForSpeech(text, opts) {
    opts = opts || {};
    var readCode = opts.readCode === true;
    var t = String(text == null ? "" : text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    t = t.replace(HTML_COMMENT_RE, " ");
    t = t.replace(FENCE_RE, function (block) {
      if (!readCode) return " " + CODE_PLACEHOLDER + " ";
      return " " + block.replace(/^```[^\n]*\n?/, "").replace(/```$/, "") + " ";
    });
    t = t.replace(IMAGE_RE, " ");
    t = t.replace(LINK_RE, "$1");
    t = t.replace(AUTOLINK_RE, " ");
    t = t.replace(URL_RE, " ");
    t = t.replace(HEADING_RE, "");
    t = t.replace(HR_RE, " ");
    t = t.replace(QUOTE_RE, "");
    t = t.replace(LIST_RE, "");
    t = t.replace(TABLE_SEP_RE, "");
    t = t.replace(/\|/g, " ");
    t = t.replace(STRIKE_RE, "$1");
    t = t.replace(BOLD_RE, "$1");
    t = t.replace(BOLD_U_RE, "$1");
    t = t.replace(ITALIC_RE, "$1");
    t = t.replace(ITALIC_U_RE, "$1$2");
    t = t.replace(/`/g, "");
    return t.replace(/\s+/g, " ").trim();
  }

  function detectLang(text) {
    var t = String(text == null ? "" : text);
    var cyr = 0, lat = 0, cjk = 0;
    for (var i = 0; i < t.length; i++) {
      var c = t.codePointAt(i);
      if (c > 0xffff) i++;
      if (c >= 0x0400 && c <= 0x04ff) cyr++;
      else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff) || (c >= 0xac00 && c <= 0xd7af)) cjk++;
      else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) lat++;
    }
    if (cjk > cyr && cjk > lat) return "zh-CN";
    if (cyr > 0 && cyr >= lat) return "ru-RU";
    return "en-US";
  }

  function voiceLang(v) {
    return String((v && v.lang) || "").toLowerCase().replace(/_/g, "-");
  }

  function pickVoice(voices, lang, opts) {
    opts = opts || {};
    var localOnly = opts.localOnly !== false;
    var list = Array.isArray(voices) ? voices : [];
    var norm = String(lang || "").toLowerCase();
    var base = norm.slice(0, 2);
    var matches = function (v) {
      var vl = voiceLang(v);
      return vl === norm || (base && vl.indexOf(base) === 0);
    };
    var pool = list.filter(function (v) {
      return matches(v) && (!localOnly || v.localService !== false);
    });
    if (pool.length) return pool.filter(function (v) { return v.default; })[0] || pool[0];
    return null;
  }

  function splitSentences(text) {
    var m = String(text == null ? "" : text).match(/[^.!?…]+[.!?…]*/g) || [];
    return m.map(function (s) { return s.trim(); }).filter(Boolean);
  }

  // «Кратко»: первые N предложений + (по решению §10.3) предложения с ошибками.
  function briefSentences(text, n, opts) {
    opts = opts || {};
    var includeErrors = opts.includeErrors !== false;
    var sentences = splitSentences(text);
    if (!sentences.length) return "";
    var take = sentences.slice(0, Math.max(1, n | 0));
    if (includeErrors) {
      for (var i = 0; i < sentences.length; i++) {
        if (ERROR_RE.test(sentences[i]) && take.indexOf(sentences[i]) === -1) take.push(sentences[i]);
      }
    }
    return take.join(" ");
  }

  // Chrome обрывает длинные utterances (~15 c) — режем на куски по предложениям.
  function chunkSentences(text, maxLen) {
    maxLen = maxLen || 180;
    var sentences = splitSentences(text);
    var chunks = [];
    var cur = "";
    for (var i = 0; i < sentences.length; i++) {
      var s = sentences[i];
      if (cur && cur.length + 1 + s.length > maxLen) { chunks.push(cur); cur = s; }
      else { cur = cur ? cur + " " + s : s; }
      while (cur.length > maxLen) { chunks.push(cur.slice(0, maxLen)); cur = cur.slice(maxLen); }
    }
    if (cur) chunks.push(cur);
    return chunks;
  }

  // Сторож залипшей речи: бюджет времени на один utterance. Очередь
  // speechSynthesis живёт в процессе рендера вкладки и может залипнуть
  // (F5 процесс не убивает — только полное закрытие вкладки); тогда нет ни
  // onend, ни onerror — тишина без ошибок. Оценка: ~14 символов/с + запас.
  function utteranceBudget(text, rate) {
    var r = Number(rate) || 1.0;
    if (!(r > 0)) r = 1.0;
    var ms = (String(text == null ? "" : text).length * 70) / r + 8000;
    if (ms < 10000) return 10000;
    if (ms > 60000) return 60000;
    return Math.round(ms);
  }

  function hashStr(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
    return (h >>> 0).toString(36);
  }

  function dedupKey(messageID, text) {
    return String(messageID || "") + ":" + hashStr(String(text || ""));
  }

  function comboMatches(e, combo) {
    var parts = String(combo || "").toLowerCase().split("+");
    var key = parts.pop();
    var needCtrl = parts.indexOf("ctrl") !== -1;
    var needAlt = parts.indexOf("alt") !== -1;
    var needShift = parts.indexOf("shift") !== -1;
    var k = String(e.key || "").toLowerCase();
    var keyOk = k === key || (key === "c" && e.code === "KeyC");
    return keyOk && !!e.ctrlKey === needCtrl && !!e.altKey === needAlt && !!e.shiftKey === needShift;
  }

  var DEFAULTS = {
    tts: false,
    ttsMode: "brief",
    ttsLang: "auto",
    ttsEngine: "browser",
    ttsVoice: "",
    ttsServerVoice: "",
    ttsRate: 1.0,
    ttsLocalOnly: true,
    ttsMaxSeconds: 60,
    ttsBriefSentences: 2,
    ttsHotkey: "ctrl+c",
    ttsDebug: false
  };

  // ------------------------------------------------------------------ runtime

  var started = false;

  function start(deps) {
    deps = deps || {};
    if (started) return;
    started = true;
    var win = deps.window || globalThis;
    var doc = win.document;
    var log = deps.log || function () {};
    var toast = deps.toast || function () {};
    var getPhase = deps.getPhase || function () { return "idle"; };
    var serverUrl = String(deps.serverUrl || "").replace(/\/+$/, "");
    var authHeaders = deps.authHeaders || function () { return {}; };
    var settings = Object.assign({}, DEFAULTS);
    var logTail = [];
    var stats = { events: 0, lastType: "", lastSid: "", finalized: 0, lastSkip: "", sourceState: "none" };
    var lastPoll = 0;
    var noVoiceRetries = 0;
    var speakFailures = 0;
    var dbg = function () {
      var args = [].slice.call(arguments);
      var line = args.map(function (a) { return typeof a === "string" ? a : JSON.stringify(a); }).join(" ");
      logTail.push(line);
      if (logTail.length > 20) logTail.shift();
      if (settings.ttsDebug) {
        try { console.log.apply(console, ["[OCV TTS]"].concat(args)); } catch (e) {}
      }
    };

    var gateOk = false;
    var source = null;
    var speaking = false;
    var pending = null;
    var spoken = Object.create(null);
    var messages = Object.create(null); // messageID -> { role, completed, order, parts }
    var maxTimer = null;
    var speechWdt = null; // сторож залипшего utterance (см. utteranceBudget)
    var stuckCount = 0; // подряд зависших utterances (сброс при успехе)
    var audioCtx = null;
    var audioEl = null;
    var serverSource = null;

    function loadSettings(cb) {
      try {
        if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) { dbg("no chrome.storage"); cb(); return; }
        chrome.storage.local.get(DEFAULTS, function (v) {
          settings = Object.assign({}, DEFAULTS, v || {});
          dbg("settings", { tts: settings.tts, mode: settings.ttsMode, lang: settings.ttsLang });
          cb();
        });
      } catch (e) { dbg("settings read failed", e); cb(); }
    }

    function isOpenCodePage(cb) {
      var sel = '[data-component="prompt-input"], [data-component="prompt-input-v2"], [role="textbox"][contenteditable="true"]';
      if (!doc || !doc.querySelector(sel)) { cb(false); return; }
      try {
        win.fetch("/session", { method: "GET", headers: { Accept: "application/json" } })
          .then(function (r) { dbg("gate: /session", r && r.status); cb(!!r && r.ok); })
          .catch(function (e) { dbg("gate: /session failed", e && e.message); cb(false); });
      } catch (e) { dbg("gate: fetch threw", e); cb(false); }
    }

    function visibleMessageEl(id) {
      if (!doc) return null;
      var els = doc.querySelectorAll("[data-message-id]");
      for (var i = 0; i < els.length; i++) {
        if (els[i].getAttribute("data-message-id") === id) return els[i];
      }
      return null;
    }

    function getMsg(id) {
      if (!messages[id]) messages[id] = { role: null, parentID: null, completed: false, order: [], parts: Object.create(null) };
      return messages[id];
    }

    function onEvent(ev) {
      var frame;
      try { frame = JSON.parse(ev.data); } catch (e) { return; }
      var d = frame && frame.data ? frame.data : {};
      var sessionID = d.sessionID || (frame.durable && frame.durable.aggregateID);
      stats.events++; stats.lastType = frame.type; stats.lastSid = sessionID || "";
      dbg("event", frame.type, sessionID);
      if (frame.type === "message.updated") {
        var info = d.info || {};
        if (!info.id) return;
        var m = getMsg(info.id);
        m.role = info.role || m.role;
        m.parentID = info.parentID || m.parentID;
        if (info.time && info.time.completed) m.completed = true;
        maybeFinalize(info.id);
      } else if (frame.type === "message.part.updated") {
        var p = d.part || {};
        if (p.type !== "text" || !p.messageID) return;
        var mm = getMsg(p.messageID);
        if (mm.order.indexOf(p.id) === -1) mm.order.push(p.id);
        mm.parts[p.id] = { text: p.text || "", end: p.time && p.time.end };
        maybeFinalize(p.messageID);
      } else if (frame.type === "session.idle") {
        var keys = Object.keys(messages);
        if (keys.length) maybeFinalize(keys[keys.length - 1], true);
      }
    }

    function assemble(m) {
      var out = [];
      for (var i = 0; i < m.order.length; i++) {
        var part = m.parts[m.order[i]];
        if (part && part.text) out.push(part.text);
      }
      return out.join(" ");
    }

    function allPartsEnded(m) {
      var any = false;
      for (var k in m.parts) {
        if (!m.parts[k].end) return false;
        any = true;
      }
      return any;
    }

    function maybeFinalize(id, force) {
      var m = messages[id];
      if (!m) return;
      if (m.role !== "assistant") { stats.lastSkip = "role=" + m.role; dbg("finalize skip: role", m.role, id); return; }
      if (!force && !m.completed && !allPartsEnded(m)) return;
      var raw = assemble(m);
      if (!raw.trim()) return;
      if (!visibleMessageEl(id) && !(m.parentID && visibleMessageEl(m.parentID))) {
        var ids = [];
        try {
          var els = doc.querySelectorAll("[data-message-id]");
          for (var i = 0; i < els.length && i < 4; i++) ids.push(els[i].getAttribute("data-message-id"));
        } catch (e) {}
        stats.lastSkip = "notInDom id=" + id + " parent=" + m.parentID;
        dbg("finalize skip: not in DOM", { id: id, parent: m.parentID, domIds: ids });
        return; // озвучиваем только видимое (главная сессия)
      }
      stats.finalized++;
      dbg("finalize", id, "len", raw.length);
      var text = cleanForSpeech(raw);
      if (!text) return;
      var key = dedupKey(id, text);
      if (spoken[key]) return;
      spoken[key] = true;
      var speakText = settings.ttsMode === "brief"
        ? briefSentences(text, settings.ttsBriefSentences, { includeErrors: true })
        : text;
      if (speakText) enqueue(speakText);
    }

    // Резервный путь (не зависит от SSE): опрашиваем снимок последних сообщений
    // самой свежей top-level сессии. Так озвучка работает, даже если поток не доходит.
    function pollOnce() {
      try {
        win.fetch("/api/session", { headers: { Accept: "application/json" } })
          .then(function (r) { return r.json(); })
          .then(function (body) {
            var list = (body && body.data) || [];
            var best = null;
            for (var i = 0; i < list.length; i++) {
              var s = list[i];
              if (!s || s.parentID) continue;
              var t = (s.time && (s.time.updated || s.time.created)) || 0;
              if (!best || t > best.t) best = { id: s.id, t: t };
            }
            if (!best) return;
            return win.fetch("/session/" + best.id + "/message?limit=3", { headers: { Accept: "application/json" } })
              .then(function (r2) { return r2.json(); })
              .then(function (msgs) { onSnapshot(Array.isArray(msgs) ? msgs : []); });
          })
          .catch(function (e) { dbg("poll failed", e && e.message); });
      } catch (e) { dbg("poll threw", e); }
    }

    function onSnapshot(msgs) {
      for (var i = msgs.length - 1; i >= 0; i--) {
        var info = (msgs[i] && msgs[i].info) || {};
        if (info.role !== "assistant") continue;
        if (!(info.time && info.time.completed)) return; // последний ответ ещё стримится
        var parts = msgs[i].parts || [];
        var raw = parts.filter(function (p) { return p.type === "text" && (p.text || "").trim(); })
          .map(function (p) { return p.text; }).join(" ");
        if (!raw.trim()) return;
        if (!visibleMessageEl(info.id) && !(info.parentID && visibleMessageEl(info.parentID))) {
          dbg("poll: row not found, speaking anyway", info.id, info.parentID);
        }
        var text = cleanForSpeech(raw);
        if (!text) return;
        var key = dedupKey(info.id, text);
        if (spoken[key]) return;
        spoken[key] = true;
        stats.finalized++;
        dbg("finalize (poll)", info.id, "len", raw.length);
        var out = settings.ttsMode === "brief"
          ? briefSentences(text, settings.ttsBriefSentences, { includeErrors: true })
          : text;
        if (out) enqueue(out);
        return;
      }
    }

    function enqueue(text) {
      if (getPhase() !== "idle") { pending = text; return; }
      speak(text);
    }

    function stopSpeaking(show) {
      pending = null;
      if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
      if (speechWdt) { clearTimeout(speechWdt); speechWdt = null; }
      if (serverSource) { try { serverSource.stop(); } catch (e) {} serverSource = null; }
      if (audioEl) { try { audioEl.pause(); } catch (e) {} audioEl = null; }
      if (win.speechSynthesis) win.speechSynthesis.cancel();
      if (speaking) { speaking = false; if (show) toast("⏹ Стоп", "warning", 1200); }
    }

    function hasUserActivation() {
      try {
        var ua = win.navigator && win.navigator.userActivation;
        return !ua || ua.hasBeenActive !== false;
      } catch (e) { return true; }
    }

    function speak(text) {
      if (settings.ttsEngine === "server" && serverUrl) { speakServer(text); return; }
      speakBrowser(text);
    }

    function speakBrowser(text) {
      var synth = win.speechSynthesis;
      if (!synth) { dbg("no speechSynthesis"); toast("Синтез речи недоступен", "error", 4000); return; }
      // До первого действия пользователя Chrome блокирует синтез (not-allowed);
      // на свежем F5 activation сброшен — молча ждём, без ошибок.
      if (!hasUserActivation()) { dbg("no user activation yet, defer"); pending = text; return; }
      var lang = settings.ttsLang === "auto" ? detectLang(text) : settings.ttsLang;
      var chunks = chunkSentences(text);
      if (!chunks.length) return;

      var begin = function (voices) {
        if (!voices.length) {
          noVoiceRetries++;
          dbg("no voices yet (retry " + noVoiceRetries + ")");
          if (noVoiceRetries <= 5) { pending = text; }
          else { toast("Нет голосов синтеза", "warning", 3000); }
          return;
        }
        noVoiceRetries = 0;
        var voice = null;
        if (settings.ttsVoice) {
          for (var vi = 0; vi < voices.length; vi++) {
            if (voices[vi].name === settings.ttsVoice) { voice = voices[vi]; break; }
          }
        }
        if (!voice) voice = pickVoice(voices, lang, { localOnly: settings.ttsLocalOnly });
        if (!voice && settings.ttsLocalOnly) {
          voice = pickVoice(voices, lang, { localOnly: false });
          if (voice) toast("Локальный голос не найден — удалённый", "warning", 3000);
        }
        dbg("speak", { lang: lang, voices: voices.length, voice: voice && voice.name, chunks: chunks.length });
        speaking = true;
        toast("🔊 Говорю…", "info", 2000);
        var idx = 0;
        var next = function () {
          if (!speaking || idx >= chunks.length) {
            if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
            speaking = false;
            return;
          }
          var chunkText = chunks[idx++];
          var send = function (withoutVoice, retried) {
            var u = new win.SpeechSynthesisUtterance(chunkText);
            u.lang = (voice && voice.lang) || lang;
            u.rate = Number(settings.ttsRate) || 1.0;
            if (!withoutVoice && voice) u.voice = voice;
            var settled = false;
            var clearWdt = function () { if (speechWdt) { clearTimeout(speechWdt); speechWdt = null; } };
            // Нет ни onend, ни onerror за бюджет — очередь залипла (процесс
            // рендера; F5 не лечит, лечит полное закрытие вкладки).
            speechWdt = setTimeout(function () {
              if (settled || !speaking) return;
              settled = true;
              speechWdt = null;
              dbg("utterance timeout", chunkText.length);
              if (!retried) {
                try { synth.cancel(); } catch (ee) {}
                setTimeout(function () { if (speaking) send(withoutVoice, true); }, 200);
                return;
              }
              speaking = false;
              stuckCount++;
              if (stuckCount >= 2) {
                stuckCount = 0;
                toast("Синтез завис — закройте вкладку полностью и откройте заново", "error", 6000);
              } else {
                pending = text;
              }
            }, utteranceBudget(chunkText, u.rate));
            u.onend = function () { if (settled) return; settled = true; clearWdt(); speakFailures = 0; stuckCount = 0; next(); };
            u.onerror = function (e) {
              if (settled) return;
              var err = e && e.error;
              dbg("utterance error", err);
              if (!speaking) return;
              if (err === "canceled" || err === "interrupted") return;
              if (!withoutVoice) {
                settled = true;
                clearWdt();
                voice = null;
                try { synth.cancel(); } catch (ee) {}
                setTimeout(function () { if (speaking) send(true); }, 150);
                return;
              }
              settled = true;
              clearWdt();
              speaking = false;
              speakFailures++;
              dbg("speak failure", speakFailures, err);
              // Первые сбои после F5 (холодный синтез) — беззвучно повторяем.
              if (speakFailures <= 3) { pending = text; }
              else { speakFailures = 0; toast("Ошибка озвучки", "error", 3000); }
            };
            try { synth.speak(u); } catch (e) { dbg("speak threw", e); speaking = false; pending = text; }
          };
          send(false);
        };
        var secs = Number(settings.ttsMaxSeconds) || 0;
        if (secs > 0) maxTimer = setTimeout(function () { stopSpeaking(true); }, secs * 1000);
        try { if (synth.paused) synth.resume(); } catch (e) {}
        next();
      };

      var voices = [];
      try { voices = synth.getVoices() || []; } catch (e) { voices = []; }
      if (voices.length) { begin(voices); return; }
      // Голоса в новом документе подгружаются асинхронно (voiceschanged).
      var done = false;
      var onVoices = function () {
        if (done) return;
        done = true;
        try { synth.removeEventListener("voiceschanged", onVoices); } catch (e) {}
        var v = [];
        try { v = synth.getVoices() || []; } catch (e) {}
        begin(v);
      };
      try { synth.addEventListener("voiceschanged", onVoices, { once: true }); } catch (e) {}
      setTimeout(function () { if (!done) onVoices(); }, 700);
    }

    // Прайминг аудио: в content-скрипте его раньше не было (бипы ушли на сервер).
    // Нужен только серверному движку — Web Speech autoplay-гейтом не ограничен.
    function primeAudio() {
      try {
        var AC = win.AudioContext || win.webkitAudioContext;
        if (!AC) return;
        if (!audioCtx) audioCtx = new AC();
        if (audioCtx.state === "suspended") audioCtx.resume().catch(function () {});
      } catch (e) {}
    }

    function playBuffer(buf, onEnd, onError) {
      primeAudio();
      var fail = function (why) { if (onError) onError(why); };
      if (audioCtx) {
        try {
          Promise.resolve(audioCtx.decodeAudioData(buf.slice(0))).then(function (decoded) {
            try {
              var src = audioCtx.createBufferSource();
              src.buffer = decoded;
              src.connect(audioCtx.destination);
              serverSource = src;
              src.onended = function () {
                if (serverSource === src) serverSource = null;
                if (onEnd) onEnd();
              };
              src.start(0);
            } catch (e) { fail("start: " + (e && e.message)); }
          }).catch(function () { fail("decode"); });
          return;
        } catch (e) {}
      }
      try {
        var url = win.URL.createObjectURL(new win.Blob([buf], { type: "audio/wav" }));
        var el = new win.Audio(url);
        audioEl = el;
        el.onended = function () {
          try { win.URL.revokeObjectURL(url); } catch (e) {}
          if (audioEl === el) audioEl = null;
          if (onEnd) onEnd();
        };
        el.onerror = function () { fail("audio element"); };
        var pr = el.play();
        if (pr && pr.catch) pr.catch(function (e) { fail("play: " + (e && e.message)); });
      } catch (e) { fail(String(e)); }
    }

    // Серверный движок: POST /speak -> WAV (играет браузер). Длинный текст режем
    // на чанки (как браузерный движок), иначе /speak отвечает 413 и всё целиком
    // откатывалось на Web Speech. При фатальной ошибке — фолбэк остатка на
    // Web Speech, чтобы ответ всё равно прозвучал.
    function speakServer(text) {
      if (!hasUserActivation()) { dbg("no user activation, defer (server)"); pending = text; return; }
      var chunks = chunkSentences(text);
      if (!chunks.length) return;
      speaking = true;
      toast("🔊 Говорю… (сервер)", "info", 2000);
      dbg("speak server", { chars: text.length, chunks: chunks.length, voice: settings.ttsServerVoice || settings.ttsVoice || null });
      var secs = Number(settings.ttsMaxSeconds) || 0;
      if (secs > 0) maxTimer = setTimeout(function () { stopSpeaking(true); }, secs * 1000);
      var idx = 0;
      var fallbackRest = function (why, fromIdx) {
        if (!speaking) return;
        speaking = false;
        if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
        dbg("server fallback -> browser", why);
        // Важно: напрямую в браузерный синтез, а не через speak() —
        // иначе роутер вернёт нас в speakServer и будет бесконечный цикл.
        var rest = chunks.slice(fromIdx).join(" ") || text;
        speakBrowser(rest);
      };
      var fetchChunk = function (chunkText) {
        var payload = { text: chunkText, mode: "full", rate: Number(settings.ttsRate) || 1.0 };
        // Серверный голос — отдельный ключ (ttsServerVoice); пусто → серверный дефолт.
        // Старый общий ttsVoice оставлен как фолбэк ради совместимости.
        var serverVoice = settings.ttsServerVoice || settings.ttsVoice;
        if (serverVoice) payload.voice = serverVoice;
        if (settings.ttsLang !== "auto") payload.lang = settings.ttsLang;
        return win.fetch(serverUrl + "/speak", {
          method: "POST",
          // authHeaders() от content.js несёт X-Voice-Source: button — наш tts
          // должен побеждать, поэтому спредим его первым.
          headers: Object.assign(
            {},
            authHeaders(),
            { "Content-Type": "application/json", "X-Voice-Source": "tts" }
          ),
          body: JSON.stringify(payload)
        }).then(function (r) {
          if (!r.ok) {
            return r.json().catch(function () { return {}; }).then(function (b) {
              throw new Error("http " + r.status + (b && b.error ? " " + b.error : ""));
            });
          }
          return r.arrayBuffer();
        });
      };
      var next = function () {
        if (!speaking || idx >= chunks.length) {
          if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
          speaking = false;
          return;
        }
        var cur = idx;
        var chunkText = chunks[cur];
        try {
          fetchChunk(chunkText).then(function (buf) {
            if (!speaking || cur !== idx) return;
            playBuffer(buf, function () {
              if (!speaking) return;
              idx++;
              next();
            }, function (why) { fallbackRest("play: " + why, cur); });
          }).catch(function (e) { fallbackRest("fetch: " + (e && e.message), cur); });
        } catch (e) { fallbackRest("throw: " + e, cur); }
      };
      next();
    }

    function onKeyDown(e) {
      if (!speaking) return; // Ctrl+C перехватываем только пока идёт речь
      if (comboMatches(e, settings.ttsHotkey)) {
        e.preventDefault();
        e.stopPropagation();
        stopSpeaking(true);
      }
    }

    function tick() {
      if (!gateOk) {
        isOpenCodePage(function (ok) {
          if (!ok) return;
          gateOk = true;
          dbg("gate ok");
          toast("🔊 Озвучка включена", "info", 2000);
          if (!source) {
            try { source = new win.EventSource("/api/event"); } catch (e) { log("sse failed", e); }
            if (source) {
              source.onopen = function () { stats.sourceState = "open"; dbg("sse open"); };
              source.onmessage = onEvent;
              source.onerror = function () { stats.sourceState = "error"; dbg("sse error (auto-reconnect)"); };
            }
          }
          log("tts active");
        });
        return;
      }
      var now = Date.now();
      if (settings.tts && now - lastPoll > 2000) { lastPoll = now; pollOnce(); }
      if (getPhase() !== "idle") {
        if (speaking) { var cur = pending; stopSpeaking(false); pending = cur; }
      } else if (pending && !speaking) {
        var t = pending; pending = null; speak(t);
      }
    }

    loadSettings(function () {
      try {
        win.addEventListener("keydown", onKeyDown, true);
        win.addEventListener("pointerdown", primeAudio, true);
        win.addEventListener("keydown", primeAudio, true);
        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
          chrome.storage.onChanged.addListener(function (changes, area) {
            if (area !== "local") return;
            for (var k in changes) if (k in DEFAULTS) settings[k] = changes[k].newValue;
            dbg("settings changed", { tts: settings.tts, mode: settings.ttsMode, lang: settings.ttsLang });
          });
        }
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
          chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
            if (!msg) return;
            if (msg.type === "ocv-tts-test") {
              speak("OpenCode Voice: озвучка ответов. Если вы это слышите, синтез работает.");
              sendResponse({ ok: true });
              return true;
            }
            if (msg.type === "ocv-tts-status") {
              sendResponse({
                ok: true, tts: settings.tts, gateOk: gateOk, hasSource: !!source, speaking: speaking,
                voices: (function () { try { return (win.speechSynthesis && win.speechSynthesis.getVoices() || []).length; } catch (e) { return -1; } })(),
                sourceState: stats.sourceState, events: stats.events, lastType: stats.lastType,
                lastSid: stats.lastSid, finalized: stats.finalized, lastSkip: stats.lastSkip,
                rows: (function () { try { return doc ? doc.querySelectorAll("[data-message-id]").length : -1; } catch (e) { return -1; } })(),
                logTail: logTail.slice(-12)
              });
              return true;
            }
          });
        }
        // Прогреваем список голосов заранее (в новом документе он грузится асинхронно).
        try {
          if (win.speechSynthesis) {
            win.speechSynthesis.getVoices();
            if (win.speechSynthesis.addEventListener) {
              win.speechSynthesis.addEventListener("voiceschanged", function () {
                dbg("voiceschanged", (win.speechSynthesis.getVoices() || []).length);
              });
            }
          }
        } catch (e) {}
      } catch (e) { dbg("tts wiring failed", e); }
      if (settings.tts) {
        setInterval(tick, 1000);
        tick();
      } else {
        var poll = setInterval(function () {
          if (settings.tts) { clearInterval(poll); setInterval(tick, 1000); tick(); }
        }, 1000);
      }
    });

    return {
      stop: stopSpeaking,
      isSpeaking: function () { return speaking; },
      settings: function () { return settings; }
    };
  }

  globalThis.OpenCodeVoiceTTS = {
    cleanForSpeech: cleanForSpeech,
    detectLang: detectLang,
    pickVoice: pickVoice,
    briefSentences: briefSentences,
    chunkSentences: chunkSentences,
    utteranceBudget: utteranceBudget,
    dedupKey: dedupKey,
    comboMatches: comboMatches,
    DEFAULTS: DEFAULTS,
    start: start
  };
})();
