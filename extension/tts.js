// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
// Озвучка ответов ассистента (аддитивный, по умолчанию выключенный слой).
//
// Источник текста — same-origin API web-UI: живой поток GET /api/event (SSE,
// без токена; конверт {type,durable,location,data}); снимок — root GET /session/{id}/message.
// Запускается из content.js через OpenCodeVoiceTTS.start({ getPhase, toast, log }).
//
// Чистые хелперы отдаются в globalThis.OpenCodeVoiceTTS — их гоняет test/tts.test.mjs
// через node:vm (кросс-паритет с src/lib/text.ts по shared/tts-cases.json).

// Версия расширения — ЕДИНСТВЕННОЕ место, где она живёт. Раньше она была
(function () {
  var TTS_VERSION = "1.0.51";
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
  // Управление озвучкой: строка, начинающаяся с 🔈, произносится, остальное —
  // нет. Так решает ассистент, а не расширение, и текст можно писать
  // естественно: короткими фразами, без разметки.
  // Политика озвучки приезжает манифестом с сервера (shared/tts-manifest.json),
  // поэтому она переносится вместе с плагином и не настраивается вручную на
  // каждой машине. Пока манифест не приехал — работают значения по умолчанию.
  var MANIFEST = null;
  var DEFAULT_MANIFEST = {
    speak: {
      mode: "normal", marker: "\uD83D\uDD08", briefSentences: 2, interChunkPauseMs: 220,
      levelOrder: ["quiet", "normal", "more", "verbose", "full"],
      levels: {
        quiet: { sentences: 1, maxChars: 120 },
        normal: { sentences: 2, maxChars: 220 },
        more: { sentences: 4, maxChars: 400 },
        verbose: { sentences: 6, maxChars: 700 },
        full: { sentences: 0, maxChars: 0 }
      }
    },
    alwaysVoicePrefixes: [],
    neverVoicePatterns: []
  };

  // Потолок по символам, режем по границам предложений, чтобы не обрывать слово.
  function capChars(text, n) {
    if (!n || n <= 0) return String(text || "");
    var one = String(text || "");
    if (one.length <= n) return one;
    var sentences = splitSentences(one);
    var out = [];
    var len = 0;
    for (var i = 0; i < sentences.length; i++) {
      var add = (out.length ? 1 : 0) + sentences[i].length;
      if (out.length && len + add > n) break;
      out.push(sentences[i]);
      len += add;
    }
    // Потолок жёсткий. Первое предложение мы пропускаем целиком, чтобы не
    // рубить фразу, но если оно одно и длиннее потолка — режем по словам.
    // Иначе «Только важное» на длинном первом предложении прочитал бы абзац.
    var joined = out.join(" ");
    if (joined.length > n) return joined.slice(0, n).replace(/\s+\S*$/, "") + "\u2026";
    return joined;
  }

  // Конфигурация уровня подробности. null = такого уровня нет ни в манифесте,
  // ни в запасе — тогда вызывающий код решает сам.
  function mLevel(id) {
    var m = MANIFEST && MANIFEST.speak ? MANIFEST.speak.levels : null;
    if (m && typeof m === "object" && m[id]) return m[id];
    return DEFAULT_MANIFEST.speak.levels[id] || null;
  }
  function mLevelOrder() {
    var m = MANIFEST && MANIFEST.speak ? MANIFEST.speak.levelOrder : null;
    return Array.isArray(m) ? m : DEFAULT_MANIFEST.speak.levelOrder;
  }
  // Старый сохранённый режим brief приводим к новому уровню normal.
  var LEGACY_MODE = { brief: "normal" };
  function levelId(mode) {
    var id = LEGACY_MODE[mode] || mode;
    return mLevel(id) ? id : "normal";
  }
  function mSpeak(k, d) {
    var m = MANIFEST && MANIFEST.speak ? MANIFEST.speak[k] : undefined;
    if (m !== undefined && m !== null && m !== "") return m;
    return d;
  }
  function mList(k) {
    var m = MANIFEST && MANIFEST[k];
    return Array.isArray(m) ? m : [];
  }

  function markedSpoken(text) {
    var mark = mSpeak("marker", DEFAULT_MANIFEST.speak.marker);
    var bans = mList("neverVoicePatterns");
    var lines = String(text || "").split(/\r?\n/);
    var picked = [];
    for (var i = 0; i < lines.length; i++) {
      // Метка засчитывается ТОЛЬКО в начале строки (за ведущей разметкой).
      // Иначе обычное упоминание символа вслух зачитывалось бы, а сам символ
      // вырезался бы из середины фразы: «приоритет: метка 🔈 → уровень»
      // превращалось в «приоритет: метка → уровень» и обгоняло настоящий
      // итог сообщения, который начинается с alwaysVoicePrefixes.
      // Порядок важен: сперва проверяем «метка сразу», и только иначе срезаем
      // ведущую разметку — иначе регулярка съела бы маркер из `>> произнести`.
      var raw = lines[i].replace(/^\s+/, "");
      if (raw.indexOf(mark) !== 0) {
        raw = raw.replace(/^[>*\-\u2022_#\s]+/, "");
        if (raw.indexOf(mark) !== 0) continue;
      }
      // Метку снимаем первым, потом ведущую разметку: так уходит и хвост
      // жирного `**🔈** текст`.
      var one = raw.replace(mark, "").replace(/^\s*[*_#>-]+\s*/, "").trim();
      if (!one) continue;
      // Страховка манифеста: помеченная строка с кодом/путём/ссылкой вслух
      // не читается — даже если метка стояла.
      var skip = false;
      for (var b = 0; b < bans.length; b++) {
        if (bans[b] && one.indexOf(bans[b]) !== -1) { skip = true; break; }
      }
      if (skip) continue;
      picked.push(one);
    }
    return picked.join(" ");
  }

  // Строки из alwaysVoicePrefixes озвучиваются ВСЕГДА, даже без метки.
  function alwaysSpoken(text) {
    var pref = mList("alwaysVoicePrefixes");
    if (!pref.length) return "";
    var bans = mList("neverVoicePatterns");
    var lines = String(text || "").split(/\r?\n/);
    var picked = [];
    for (var i = 0; i < lines.length; i++) {
      var one = lines[i].replace(/^\s*[*_#>-]+\s*/, "").trim();
      if (!one) continue;
      var hit = false;
      for (var p = 0; p < pref.length; p++) {
        if (pref[p] && one.indexOf(pref[p]) === 0) { hit = true; break; }
      }
      if (!hit) continue;
      var skip = false;
      for (var b = 0; b < bans.length; b++) {
        if (bans[b] && one.indexOf(bans[b]) !== -1) { skip = true; break; }
      }
      if (skip) continue;
      picked.push(one);
    }
    return picked.join(" ");
  }

  // Журнал живёт внутри start(), но pickSpoken() — снаружи. Поэтому здесь
  // крючок, который start() подменяет на реальный журнализатор. Без него
  // решение «почему прозвучало / почему нет» вообще нигде не остаётся.
  var REPORTER = function () {};

  // Порядок приоритета: пометка важнее уровня, уровень важнее автоматики.
  // manual — не уровень, а отдельная философия: без метки не звучит ничего.
  // Третий аргумент (briefN) оставлен для совместимости вызова и игнорируется:
  // с 1.0.47 число предложений задаёт уровень из манифеста, иначе старое
  // сохранённое значение заблокировало бы шкалу у всех, кто давно пользуется.
  function pickSpoken(text, mode, briefN) {
    var marked = markedSpoken(text);
    if (marked) { REPORTER("mark", { mode: mode, chars: marked.length, text: marked.slice(0, 90) }); return marked; }
    var always = alwaysSpoken(text);
    if (always) { REPORTER("always", { mode: mode, chars: always.length, text: always.slice(0, 90) }); return always; }
    if (mode === "manual") { REPORTER("skip", { mode: mode, reason: "режим manual, метки нет" }); return ""; }
    var cfg = mLevel(levelId(mode)) || {};
    var sentences = cfg.sentences | 0;
    if (sentences <= 0) {
      REPORTER("level", { mode: mode, all: true, chars: (text || "").length });
      return String(text || "");   // full — без ограничений
    }
    var out = capChars(briefSentences(text, sentences, { includeErrors: true }), cfg.maxChars);
    if (!out) { REPORTER("skip", { mode: mode, reason: "уровень не дал текста" }); return ""; }
    REPORTER("level", { mode: mode, sentences: sentences, chars: out.length, text: out.slice(0, 90) });
    return out;
  }

  // Единая точка применения манифеста: её зовёт и загрузка с сервера, и тесты.
  function applyManifest(m) {
    MANIFEST = (m && m.status === "ok") ? m : (m || null);
    return !!MANIFEST;
  }

  // Единая точка применения манифеста: её зовёт и загрузка с сервера, и тесты.
  function applyManifest(m) {
    MANIFEST = (m && m.status === "ok") ? m : (m || null);
    return !!MANIFEST;
  }


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
    // finalized — сообщения ПРОЧИТАНЫ; spoken — реально ПОСТАВЛЕНЫ в озвучку.
    // Раньше был только finalized, и в режиме manual он рос, хотя молчал:
    // по такому числу нельзя понять, звучало что-то или нет.
    var stats = { events: 0, lastType: "", lastSid: "", finalized: 0, spoken: 0, lastSkip: "", sourceState: "none" };
    var lastPoll = 0;
    var pollDirty = false; // событие message.*/session.* — опрос пора обновить
    var noVoiceRetries = 0;
    var speakFailures = 0;
    // Структурированный журнал озвучки. Отдельные записи: метка найдена,
    // обязательная фраза, выбор по уровню, ушло в синтез, синтез закончился
    // или упал, и почему не прозвучало. Кольцевой буфер — хватает на разбор
    // молчания без DevTools, а кнопка в popup отдаёт его одной строкой.
    var LOG_MAX = 200;
    var logEvents = [];
    function stamp() {
      try {
        var d = new Date();
        var p2 = function (v) { return v < 10 ? "0" + v : String(v); };
        return p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds());
      } catch (e) { return "--:--:--"; }
    }
    function logEvent(kind, data) {
      var ev = { t: stamp(), kind: kind };
      if (data) for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) ev[k] = data[k];
      logEvents.push(ev);
      if (logEvents.length > LOG_MAX) logEvents.shift();
      try { dbg(kind, data || ""); } catch (e) {}
      return ev;
    }
    function logFormat(ev) {
      var bits = [ev.t, ev.kind];
      for (var k in ev) {
        if (k === "t" || k === "kind") continue;
        bits.push(k + "=" + JSON.stringify(ev[k]));
      }
      return bits.join(" ");
    }
    // pickSpoken() живёт снаружи start() и зовёт этот крючок.
    REPORTER = logEvent;

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

    // Признак "это страница OpenCode" — живой ответ /session, а НЕ разметка.
    // Раньше гейт сначала требовал конкретные CSS-атрибуты ([data-component=
    // "prompt-input"] и т.п.). После обновления веб-интерфейса они могли
    // исчезнуть, и гейт оставался закрытым НАВСЕГДА: авто-озвучка молчала,
    // хотя кнопка "Тест" в popup работала — она зовёт speak() напрямую и
    // гейт не проходит. Теперь разметка лишь пишет предупреждение в отладку.
    function isOpenCodePage(cb) {
      var sel = '[data-component="prompt-input"], [data-component="prompt-input-v2"], [role="textbox"][contenteditable="true"]';
      var hasMarker = !!(doc && doc.querySelector(sel));
      if (!hasMarker) dbg("gate: разметка prompt-input не найдена, решает /session");
      // Критично: /session отдаёт HTML-заглушку SPA с кодом 200. Раньше это
      // считалось успехом, и настоящая ошибка 401 от /api/session пряталась —
      // гейт зелёный, а сообщения не читаются (fin:0). Успех = 2xx И JSON.
      var probe = function (path) {
        return win.fetch(path, { method: "GET", headers: { Accept: "application/json" }, credentials: "same-origin" })
          .then(function (r) {
            var ct = (r.headers && r.headers.get("content-type")) || "";
            var json = ct.indexOf("json") !== -1;
            dbg("gate:", path, r && r.status, ct.split(";")[0]);
            return { path: path, ok: !!(r && r.ok && json), status: r && r.status, auth: r && r.status === 401 };
          })
          .catch(function (e) { dbg("gate: " + path + " failed", e && e.message); return { path: path, ok: false }; });
      };
      probe("/api/session").then(function (a) {
        if (a.ok) { cb(true); return; }
        if (a.auth) {
          // Явная диагностика вместо тишины.
          dbg("gate: API требует авторизацию (401) — авто-озвучка не сможет читать ответы");
          cb("unauthorized");
          return;
        }
        return probe("/session").then(function (b) { cb(a.ok || b.ok); });
      }).catch(function (e) { dbg("gate: probe threw", e && e.message); cb(false); });
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
      // События теперь в пространстве имён (message.part.*, session.step.*).
      // Формат payload меняется между версиями, поэтому вместо разбора шлём
      // сигнал «опрос устарел» и читаем состояние через API — оно едино.
      if (/^(message|session)\./.test(frame.type || "")) pollDirty = true;
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
      var speakText = pickSpoken(text, settings.ttsMode, settings.ttsBriefSentences);
      if (speakText) enqueue(speakText);
    }

    // Резервный путь (не зависит от SSE): опрашиваем снимок последних сообщений
    // самой свежей top-level сессии. Так озвучка работает, даже если поток не доходит.
    function pollOnce() {
      try {
        var pick = function (path) {
          return win.fetch(path, { headers: { Accept: "application/json" }, credentials: "same-origin" })
            .then(function (r) {
              var ct = (r.headers && r.headers.get("content-type")) || "";
              if (r.status === 401) { dbg("poll: 401 — нужен пароль OpenCode-сервера"); return []; }
              if (ct.indexOf("json") === -1) { dbg("poll: " + path + " отдал " + (ct.split(";")[0] || "?") + ", не JSON"); return []; }
              return r.json();
            })
            .then(function (body) { return (body && body.data) || body || []; });
        };
        pick("/api/session").then(function (a) { return a && a.length ? a : pick("/session").then(function (b) { return b && b.length ? b : a; }); })
          .then(function (list) {
            list = list || [];
            var best = null;
            for (var i = 0; i < list.length; i++) {
              var s = list[i];
              if (!s || s.parentID) continue;
              var t = (s.time && (s.time.updated || s.time.created)) || 0;
              if (!best || t > best.t) best = { id: s.id, t: t };
            }
            if (!best) return;
            // Путь сообщений: /session/{id}/message — V1-стиль, на веб-сервере
            // такого маршрута нет и приходит HTML-заглушка. Раньше здесь стоял
            // голый r2.json() — он и давал «Unexpected token '<'» в отладке.
            var msgPath = "/api/session/" + best.id + "/message?limit=3";
            return win.fetch(msgPath, { headers: { Accept: "application/json" }, credentials: "same-origin" })
              .then(function (r2) {
                var ct = (r2.headers && r2.headers.get("content-type")) || "";
                if (r2.status === 401) { dbg("poll: 401 на сообщениях — нужен пароль сервера"); return []; }
                if (ct.indexOf("json") === -1) { dbg("poll: сообщения вернули " + (ct.split(";")[0] || "?") + ", не JSON"); return []; }
                return r2.json();
              })
              .then(function (msgs) {
                var body = msgs && msgs.data ? msgs.data : msgs;
                onSnapshot(Array.isArray(body) ? body : []);
              });
          })
          .catch(function (e) { dbg("poll failed", e && e.message); });
      } catch (e) { dbg("poll threw", e); }
    }

    // Форма сообщения менялась между версиями:
    //   V1: { info: { id, role, time }, parts: [{ type:"text", text }] }
    //   V2: { id, type:"assistant", time, content: [{ type:"text", text }] }
    // Раньше читались только V1-поля, поэтому в V2 цикл всегда уходил в
    // continue и ни одно сообщение не озвучивалось (fin:0). Нормализуем оба вида.
    function normMessage(row) {
      if (!row || typeof row !== "object") return null;
      var info = row.info || row;
      var parts = row.parts || row.content || [];
      return {
        id: info.id || row.id || "",
        role: info.role || info.type || "",
        parentID: info.parentID || "",
        completed: !!(info.time && info.time.completed),
        text: parts.filter(function (p) { return p && p.type === "text" && (p.text || "").trim(); })
          .map(function (p) { return p.text; }).join(" ")
      };
    }

    function onSnapshot(msgs) {
      for (var i = msgs.length - 1; i >= 0; i--) {
        var nm = normMessage(msgs[i]);
        if (!nm) continue;
        if (nm.role !== "assistant") continue;
        if (!nm.completed) return; // последний ответ ещё стримится
        var raw = nm.text;
        if (!raw.trim()) return;
        if (!visibleMessageEl(nm.id) && !(nm.parentID && visibleMessageEl(nm.parentID))) {
          dbg("poll: нет в DOM, читаем из API (озвучка не зависит от вёрстки)", nm.id, nm.parentID);
        }
        var text = cleanForSpeech(raw);
        if (!text) return;
        var key = dedupKey(nm.id, text);
        if (spoken[key]) return;
        spoken[key] = true;
        stats.finalized++;
        dbg("finalize (poll)", nm.id, "len", raw.length);
        var out = pickSpoken(text, settings.ttsMode, settings.ttsBriefSentences);
        if (out) enqueue(out);
        return;
      }
    }

    function enqueue(text) {
      if (!text) return;
      stats.spoken++;
      if (getPhase() !== "idle" || speaking) { pending = text; return; }
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
      // Единая точка входа. Раньше она не проверяла занятость, поэтому любой
      // второй вызов (тест в popup, tick, enqueue) начинал говорить поверх уже
      // идущей речи — два AudioBufferSource / два utterance звучали одновременно.
      // Гарантия: одновременно говорит только один голос.
      if (speaking) {
        logEvent("speak.interrupt", { chars: (text || "").length });
        dbg("speak: прерываю текущую речь перед новой");
        stopSpeaking(false);
      }
      // Главная запись журнала: вот что уходит в синтез.
      logEvent("speak", {
        engine: settings.ttsEngine === "server" && serverUrl ? "server" : "browser",
        chars: (text || "").length,
        text: String(text || "").slice(0, 120)
      });
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
    // Возвращает true, если Web Audio реально готов играть. Контекст в
    // состоянии suspended (autoplay-политика Chrome) даёт РАБОТАЮЩИЙ src.start()
    // без единого звука и без исключения — раньше это молча превращалось в полную
    // тишину, потому что ветка с <audio> была недостижима: audioCtx создавался
    // всегда. Теперь suspended-контекст уводит нас на элемент <audio>, где
    // play() честно реджектит и срабатывает фолбэк на Web Speech.
    function primeAudio() {
      try {
        var AC = win.AudioContext || win.webkitAudioContext;
        if (!AC) return false;
        if (!audioCtx) audioCtx = new AC();
        if (audioCtx.state === "suspended") audioCtx.resume().catch(function () {});
        return audioCtx.state === "running";
      } catch (e) { return false; }
    }

    function playBuffer(buf, onEnd, onError) {
      var fail = function (why) { if (onError) onError(why); };
      // suspended/racing контекст молчит — идём на <audio>, у него play()
      // возвращает отказ при блокировке автовоспроизведения.
      if (!primeAudio() || !audioCtx) {
        dbg("playBuffer: audioCtx not running, use <audio>");
      }
      if (audioCtx && audioCtx.state === "running") {
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
      // Раньше здесь был жёсткий return при hasBeenActive === false: текст
      // возвращался в pending и tick() ставил его обратно в pending же, то есть
      // синтез молчал бесконечно. Теперь пробуем сразу — реальный отказ
      // придёт из play()/decode и уйдёт в fallbackRest -> Web Speech.
      if (!hasUserActivation()) dbg("no user activation, trying anyway (server)");
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
      var fetchChunk = function (chunkText, retryNoVoice) {
        var payload = { text: chunkText, mode: "full", rate: Number(settings.ttsRate) || 1.0 };
        // ТОЛЬКО ttsServerVoice. Раньше здесь стоял фолбэк `|| settings.ttsVoice`
        // «ради совместимости», и он ломал озвучку: ttsVoice хранит имя голоса
        // Web Speech (например «Microsoft Irina Online (Natural)»), которого в
        // каталоге Piper нет. Сервер отвечал 400 "unknown voice (not in catalog)",
        // расширение откатывалось на браузерный синтез — и при заблокированном
        // автовоспроизведении пользователь слышал тишину. Теперь пусто = серверный
        // дефолт, как и обещает комментарий.
        var serverVoice = settings.ttsServerVoice;
        if (serverVoice && !retryNoVoice) payload.voice = serverVoice;
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
              var msg = (b && b.error) || "";
              // Самовосстановление: сервер не знает голос — почти всегда это
              // устаревшее значение из popup (например, голос удалили или сменили
              // набор). Чистим настройку и повторяем БЕЗ voice, чтобы сервер взял
              // свой дефолт. Один ретрай, без зацикливания.
              if (r.status === 400 && !retryNoVoice && /voice/i.test(msg)) {
                dbg("server does not know voice, retry without voice", msg);
                if (settings.ttsServerVoice) {
                  settings.ttsServerVoice = "";
                  try {
                    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
                      chrome.storage.local.set({ ttsServerVoice: "" });
                    }
                  } catch (e) {}
                }
                return fetchChunk(chunkText, true);
              }
              throw new Error("http " + r.status + (msg ? " " + msg : ""));
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
              // Короткая пауза между фразами: слитная речь звучит как
              // робот, пауза даёт естественный темп.
              setTimeout(next, 220);
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
          // Строгое сравнение: гейт умеет вернуть "unauthorized", а строка
          // истинна — обычная проверка if (!ok) её пропустила бы.
          if (ok !== true) {
            if (ok === "unauthorized") {
              stats.lastSkip = "api-401";
              dbg("gate: авто-озвучка выключена — сервер требует пароль");
            }
            return;
          }
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
      // Пришло событие message.*/session.* — не ждём обычного двухсекундного
      // такта, а читаем состояние сразу: ответ уже завершён, озвучивать надо
      // сейчас, иначе пользователь ждёт лишние секунды.
      if (settings.tts && (pollDirty || now - lastPoll > 2000)) {
        lastPoll = now; pollDirty = false; pollOnce();
      }
      if (getPhase() !== "idle") {
        if (speaking) { var cur = pending; stopSpeaking(false); pending = cur; }
      } else if (pending && !speaking) {
        var t = pending; pending = null; speak(t);
      }
    }

    loadSettings(function () {
      // Сначала стартуем, потом грузим манифест — параллельно, а не в цепочке.
      // Раньше startTicking() ждал колбэка манифеста, и любой сбой манифеста
      // глушил расширение целиком. Манифест влияет только на выбор текста и
      // имеет дефолты, поэтому ждать его нельзя: первый ответ успевает
      // озвучиться по дефолтам, а приехавший манифест подхватит следующий.
      startTicking();
      loadManifest(function (ok) { dbg("manifest:", ok ? "загружен" : "дефолты"); });
    });


    // Загрузка манифеста с сервера. Не критично: при любой неудаче остаются
    // дефолты. Обязательные гарантии:
    //   1) колбэк зовётся ВСЕГДА и ровно один раз — на это опирается вызов;
    //   2) исключение не выходит наружу (иначе падал весь content-скрипт);
    //   3) есть таймаут, чтобы зависший запрос не держал обещание вечно.
    // Раньше здесь стоял голый win.fetch, и если он бросал или провисал, до
    // startTicking() дело не доходило: расширение молча теряло озвучку И ответ
    // popup на ocv-tts-status — то есть «статус недоступен» без всякой причины.
    var MANIFEST_TIMEOUT_MS = 4000;
    function loadManifest(cb) {
      var done = false;
      function once(ok) { if (done) return; done = true; try { cb(ok); } catch (e) { dbg("manifest cb failed", e); } }
      var timer = null;
      try {
        if (!serverUrl || typeof win.fetch !== "function") { once(false); return; }
        timer = win.setTimeout(function () { dbg("manifest: таймаут"); once(false); }, MANIFEST_TIMEOUT_MS);
        win.fetch(serverUrl + "/manifest", { headers: { Accept: "application/json" } })
          .then(function (r) { return r.json(); })
          .then(function (m) {
            if (timer) win.clearTimeout(timer);
            once(applyManifest(m));
          })
          .catch(function (e) {
            if (timer) win.clearTimeout(timer);
            dbg("manifest: не загружен", e && e.message);
            once(false);
          });
      } catch (e) {
        dbg("manifest: исключение", e && e.message);
        once(false);
      }
    }

    function startTicking() {
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
                // Версия и уровень — в шапку копируемого журнала, чтобы по
                // одному вставленному куску было видно, на чём вообще гоняли.
                ver: TTS_VERSION, mode: settings.ttsMode,
                level: levelId(settings.ttsMode),
                manifest: MANIFEST ? "ok" : "default",
                voices: (function () { try { return (win.speechSynthesis && win.speechSynthesis.getVoices() || []).length; } catch (e) { return -1; } })(),
                sourceState: stats.sourceState, events: stats.events, lastType: stats.lastType, spoken: stats.spoken,
                lastSid: stats.lastSid, finalized: stats.finalized, lastSkip: stats.lastSkip,
                rows: (function () { try { return doc ? doc.querySelectorAll("[data-message-id]").length : -1; } catch (e) { return -1; } })(),
                logTail: logTail.slice(-12),
                // Готовые строки для копирования: кнопка в popup отдаёт их
                // одним куском, чтобы можно было прислать разбор молчания.
                eventsLog: logEvents.slice(-120).map(logFormat)
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
    }

    return {
      stop: stopSpeaking,
      isSpeaking: function () { return speaking; },
      settings: function () { return settings; },
      // Живёт внутри start(), потому что пользуется serverUrl/win/dbg.
      // Наружу отдаётся отсюда, а не из модульного объекта.
      loadManifest: loadManifest
    };
  }

  globalThis.OpenCodeVoiceTTS = {
    cleanForSpeech: cleanForSpeech,
    detectLang: detectLang,
    pickVoice: pickVoice,
    briefSentences: briefSentences,
    capChars: capChars,
    mLevel: mLevel,
    mLevelOrder: mLevelOrder,
    levelId: levelId,
    chunkSentences: chunkSentences,
    markedSpoken: markedSpoken,
    alwaysSpoken: alwaysSpoken,
    pickSpoken: pickSpoken,
    applyManifest: applyManifest,
    utteranceBudget: utteranceBudget,
    dedupKey: dedupKey,
    comboMatches: comboMatches,
    DEFAULTS: DEFAULTS,
    TTS_VERSION: TTS_VERSION,
    start: start
  };
})();
