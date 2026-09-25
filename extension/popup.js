// OpenCode Voice — © 2026 Di1r1 · MIT · https://github.com/Di1r1/OpenCode-Voice
// OpenCode Voice - Popup Script

// Хост сервера: по умолчанию 127.0.0.1, но content.js запоминает хост страницы
// (актуально при доступе к OpenCode по LAN/IP) — читаем его ниже.
let STT_SERVER = 'http://127.0.0.1:8765';
// Хост из storage принимается только для loopback: иначе токен и аудио ушли бы
// на произвольный хост (см. TRUSTED_STT_HOSTS в content.js).
const TRUSTED_STT_HOSTS = ['localhost', '127.0.0.1', '::1'];
function trustedSttHost(raw) {
  const host = String(raw || '')
    .replace(/^https?:\/\//, '')
    .replace(/:\d+$/, '')
    .replace(/^\[/, '')
    .replace(/\]$/, '');
  if (!host) return '';
  return TRUSTED_STT_HOSTS.includes(host) ? '127.0.0.1' : '';
}
// Пока идёт восстановление, не показываем красные ошибки на транзиентных сбоях.
let healing = false;

// Язык интерфейса popup (chrome.storage.local.uiLang, по умолчанию ru).
// Статика — через data-i18n в popup.html, динамика — через t() ниже.
const UI_LANGS = ['ru', 'en'];
let uiLang = 'ru';
const UI = {
  ru: {
    checking: 'Проверка...',
    beeps: 'Звуковые сигналы',
    hotkeyLabel: 'Комбинация (удержание)',
    hk_alt_z: 'Alt+Z (по умолчанию)',
    sendHotkey: 'Alt+X — запись и сразу отправка',
    tts: '🔊 Озвучивать ответы ассистента',
    ttsEngineLabel: 'Движок озвучки',
    eng_browser: 'Браузер (Web Speech)',
    eng_server: 'Сервер (Piper; нужен OPENCODE_VOICE_TTS=1)',
    ttsModeLabel: 'Режим озвучки',
    mode_brief: 'Кратко (первые предложения)',
    mode_manual: 'Только помеченное (🔈)',
    mode_full: 'Полностью',
    ttsLangLabel: 'Язык озвучки',
    lang_auto: 'Авто (по тексту)',
    lang_ru: 'Русский',
    voiceLabel: 'Голос',
    voice_auto: 'Авто (по языку)',
    remoteVoice: ' (сеть)',
    serverVoiceLabel: 'Голос сервера (Piper)',
    serverVoice_default: 'По умолчанию ({def})',
    serverVoice_down: 'Сервер недоступен (проверьте /health)',
    localOnly: 'Только локальные голоса',
    debug: 'Лог в консоль (отладка)',
    speed: 'Скорость:',
    tokenLabel: 'Токен доступа',
    tokenPh: 'OPENCODE_VOICE_TOKEN (необязательно)',
    uiLangLabel: 'Язык интерфейса',
    beepTest: '🔔 Проверить звук',
    ttsTest: '🔊 Тест озвучки',
    sttTest: 'Тест STT сервера',
    sttTesting: 'Тестирование...',
    heal: '🔧 Восстановить сервер',
    healing: '🔧 Восстанавливаю…',
    openSettings: 'Открыть настройки',
    infoFooter: 'Работает на http://127.0.0.1:8765 (локальный STT-сервер). Установка и запуск — ./setup.sh, диагностика — doctor.sh.',
    versions: 'Расширение v{ext} · сервер v{ver} ({backend}/{device})',
    statusOk: '✅ STT сервер v{ver} · {backend}',
    statusDown: '❌ STT сервер недоступен: {err}',
    statusWait: '⏳ Жду сервер…',
    statusWaitSec: '⏳ Жду сервер… {sec} с',
    statusRestarted: '✅ Сервер перезапущен · v{ver} · {backend}',
    statusRestartFail: '❌ Сервер не поднялся за отведённое время — запустите doctor.sh --fix (или ./setup.sh)',
    testSent: '🔊 Тест отправлен — должна звучать фраза',
    noContentScript: '⚠️ Content-скрипт не ответил',
    openPage: '⚠️ Откройте страницу OpenCode и обновите её (F5)',
    noTab: 'нет активной вкладки',
    noStatus: 'content-скрипт не отвечает (обновите страницу F5)',
    onServer: 'на сервере',
    emptyResp: '(пусто)',
    statusNA: 'статус недоступен (обновите страницу F5)',
    ttsReady: 'озвучка готова (подробности — галочка «Отладка»)',
    ttsWaiting: 'озвучка ждёт страницу OpenCode (F5)',
    testOk: '✅ Тест OK: "{text}"',
    testErr: '❌ Ошибка теста: {err}',
    healingServer: '🔧 Перезапускаю STT-сервер…',
    beepDown: '❌ STT сервер недоступен',
  },
  en: {
    checking: 'Checking...',
    beeps: 'Beeps',
    hotkeyLabel: 'Hotkey (hold)',
    hk_alt_z: 'Alt+Z (default)',
    sendHotkey: 'Alt+X — record and send immediately',
    tts: '🔊 Read assistant answers aloud',
    ttsEngineLabel: 'TTS engine',
    eng_browser: 'Browser (Web Speech)',
    eng_server: 'Server (Piper; needs OPENCODE_VOICE_TTS=1)',
    ttsModeLabel: 'TTS mode',
    mode_brief: 'Brief (first sentences)',
    mode_manual: 'Only marked (🔈)',
    mode_full: 'Full',
    ttsLangLabel: 'TTS language',
    lang_auto: 'Auto (by text)',
    lang_ru: 'Russian',
    voiceLabel: 'Voice',
    voice_auto: 'Auto (by language)',
    remoteVoice: ' (network)',
    serverVoiceLabel: 'Server voice (Piper)',
    serverVoice_default: 'Default ({def})',
    serverVoice_down: 'Server unavailable (check /health)',
    localOnly: 'Local voices only',
    debug: 'Console log (debug)',
    speed: 'Speed:',
    tokenLabel: 'Access token',
    tokenPh: 'OPENCODE_VOICE_TOKEN (optional)',
    uiLangLabel: 'Interface language',
    beepTest: '🔔 Test sound',
    ttsTest: '🔊 Test TTS',
    sttTest: 'Test STT server',
    sttTesting: 'Testing...',
    heal: '🔧 Heal server',
    healing: '🔧 Healing…',
    openSettings: 'Open settings',
    infoFooter: 'Runs on http://127.0.0.1:8765 (local STT server). Install & run — ./setup.sh, diagnostics — doctor.sh.',
    versions: 'Extension v{ext} · server v{ver} ({backend}/{device})',
    statusOk: '✅ STT server v{ver} · {backend}',
    statusDown: '❌ STT server unavailable: {err}',
    statusWait: '⏳ Waiting for server…',
    statusWaitSec: '⏳ Waiting for server… {sec}s',
    statusRestarted: '✅ Server restarted · v{ver} · {backend}',
    statusRestartFail: '❌ Server did not come up in time — run doctor.sh --fix (or ./setup.sh)',
    testSent: '🔊 Test sent — you should hear a phrase',
    noContentScript: '⚠️ Content script did not respond',
    openPage: '⚠️ Open the OpenCode page and reload it (F5)',
    noTab: 'no active tab',
    noStatus: 'content script is not responding (reload the page with F5)',
    onServer: 'on server',
    emptyResp: '(empty)',
    statusNA: 'status unavailable (reload the page with F5)',
    ttsReady: 'speech ready (tick Debug for details)',
    ttsWaiting: 'speech is waiting for the OpenCode page (F5)',
    testOk: '✅ Test OK: "{text}"',
    testErr: '❌ Test error: {err}',
    healingServer: '🔧 Restarting STT server…',
    beepDown: '❌ STT server unavailable',
  },
};

function t(key, vars) {
  let s = (UI[uiLang] && UI[uiLang][key]) ?? UI.ru[key] ?? key;
  if (vars) for (const k in vars) s = s.replaceAll('{' + k + '}', String(vars[k]));
  return s;
}

function applyUiLang(lang) {
  uiLang = UI_LANGS.includes(lang) ? lang : 'ru';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const v = (UI[uiLang] && UI[uiLang][el.getAttribute('data-i18n')]) || '';
    if (v) el.textContent = v;
  });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    const v = (UI[uiLang] && UI[uiLang][el.getAttribute('data-i18n-ph')]) || '';
    if (v) el.placeholder = v;
  });
  const sel = document.getElementById('uiLang');
  if (sel) sel.value = uiLang;
  // Динамические строки перерисовываем на новом языке.
  if (typeof fillVoices === 'function') fillVoices();
  if (typeof fillServerVoices === 'function') void fillServerVoices();
  if (typeof checkServer === 'function') void checkServer();
  if (typeof refreshTtsStatus === 'function') void refreshTtsStatus();
  // Кнопки с состоянием (Тест/Восстановление) возвращаем к покоящимся подписям.
  if (typeof testBtn !== 'undefined' && testBtn && !testBtn.disabled) testBtn.textContent = t('sttTest');
  if (typeof healBtn !== 'undefined' && healBtn && !healBtn.disabled) healBtn.textContent = t('heal');
}

const uiLangEl = document.getElementById('uiLang');
chrome.storage.local.get({ uiLang: 'ru' }, (v) => applyUiLang(v.uiLang || 'ru'));
if (uiLangEl) uiLangEl.addEventListener('change', () => {
  chrome.storage.local.set({ uiLang: uiLangEl.value });
  applyUiLang(uiLangEl.value);
});
const statusEl = document.getElementById('status');
const testBtn = document.getElementById('testBtn');
const openBtn = document.getElementById('openBtn');
const beepsEl = document.getElementById('beeps');
const beepTestBtn = document.getElementById('beepTestBtn');
const tokenEl = document.getElementById('token');

// Токен доступа (если на сервере задан OPENCODE_VOICE_TOKEN) и хост сервера.
chrome.storage.local.get({ token: '', sttHost: '' }, (v) => {
  tokenEl.value = v.token || '';
  const host = trustedSttHost(v.sttHost);
  if (host) STT_SERVER = `http://${host}:8765`;
  checkServer();
});
tokenEl.addEventListener('change', () => {
  chrome.storage.local.set({ token: tokenEl.value.trim() });
  checkServer();
  fillServerVoices();
});

function authHeaders() {
  const token = tokenEl.value.trim();
  return token ? { 'X-Voice-Token': token } : {};
}

// Настройка «звуковые сигналы» (хранится в chrome.storage.local, читается content.js)
chrome.storage.local.get({ beeps: true }, (v) => {
  beepsEl.checked = v.beeps !== false;
});
beepsEl.addEventListener('change', () => {
  chrome.storage.local.set({ beeps: beepsEl.checked });
});

// Комбинация push-to-talk (читается content.js через chrome.storage.onChanged)
const hotkeyEl = document.getElementById('hotkey');
chrome.storage.local.get({ hotkey: 'alt+z' }, (v) => {
  hotkeyEl.value = v.hotkey || 'alt+z';
});
hotkeyEl.addEventListener('change', () => {
  chrome.storage.local.set({ hotkey: hotkeyEl.value });
});

// Alt+X: запись + немедленная отправка (второй хоткей).
const sendHotkeyEl = document.getElementById('sendHotkey');
chrome.storage.local.get({ sendHotkey: true }, (v) => {
  sendHotkeyEl.checked = v.sendHotkey !== false;
});
sendHotkeyEl.addEventListener('change', () => {
  chrome.storage.local.set({ sendHotkey: sendHotkeyEl.checked });
});

// Озвучка ответов ассистента (ключи читают content.js/tts.js).
const ttsEl = document.getElementById('tts');
const ttsEngineEl = document.getElementById('ttsEngine');
const ttsModeEl = document.getElementById('ttsMode');
const ttsLangEl = document.getElementById('ttsLang');
const ttsLocalOnlyEl = document.getElementById('ttsLocalOnly');
const ttsRateEl = document.getElementById('ttsRate');
const ttsRateVal = document.getElementById('ttsRateVal');
const ttsDebugEl = document.getElementById('ttsDebug');
const ttsVoiceEl = document.getElementById('ttsVoice');

// Список голосов системы (грузится асинхронно — voiceschanged).
function fillVoices(selected) {
  const cur = selected !== undefined ? selected : ttsVoiceEl.value;
  const voices = (typeof speechSynthesis !== 'undefined' && speechSynthesis.getVoices()) || [];
  ttsVoiceEl.innerHTML = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = t('voice_auto');
  ttsVoiceEl.appendChild(auto);
  for (const v of voices) {
    const o = document.createElement('option');
    o.value = v.name;
    o.textContent = `${v.name} — ${v.lang}${v.localService === false ? t('remoteVoice') : ''}${v.default ? ' ★' : ''}`;
    ttsVoiceEl.appendChild(o);
  }
  ttsVoiceEl.value = cur || '';
}
if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.addEventListener('voiceschanged', () => fillVoices());
}

// Голоса серверного движка (Piper): каталог отдаёт GET /voices.
// Отдельный ключ ttsServerVoice — выбор браузерного голоса не задевает.
const ttsServerVoiceEl = document.getElementById('ttsServerVoice');
async function fillServerVoices(selected) {
  const cur = selected !== undefined ? selected : ttsServerVoiceEl.value;
  const setOpts = (items, disabled) => {
    ttsServerVoiceEl.innerHTML = '';
    for (const it of items) {
      const o = document.createElement('option');
      o.value = it.value;
      o.textContent = it.label;
      if (it.disabled) o.disabled = true;
      ttsServerVoiceEl.appendChild(o);
    }
    ttsServerVoiceEl.disabled = !!disabled;
    ttsServerVoiceEl.value = cur || '';
  };
  try {
    const res = await fetch(`${STT_SERVER}/voices`, { headers: authHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = await res.json();
    const items = [{ value: '', label: t('serverVoice_default', { def: info.default || t('onServer') }) }];
    for (const name of info.voices || []) items.push({ value: name, label: name });
    setOpts(items, false);
  } catch {
    setOpts([{ value: '', label: t('serverVoice_down') }], true);
  }
}

chrome.storage.local.get(
  { tts: false, ttsEngine: 'browser', ttsMode: 'brief', ttsLang: 'auto', ttsVoice: '', ttsServerVoice: '', ttsLocalOnly: true, ttsRate: 1.0, ttsDebug: false },
  (v) => {
    ttsEl.checked = v.tts === true;
    ttsEngineEl.value = v.ttsEngine || 'browser';
    ttsModeEl.value = v.ttsMode || 'brief';
    ttsLangEl.value = v.ttsLang || 'auto';
    ttsLocalOnlyEl.checked = v.ttsLocalOnly !== false;
    ttsRateEl.value = String(v.ttsRate || 1.0);
    ttsRateVal.textContent = Number(ttsRateEl.value).toFixed(1);
    ttsDebugEl.checked = v.ttsDebug === true;
    ttsVoiceEl.value = v.ttsVoice || '';
    fillVoices(v.ttsVoice || '');
    fillServerVoices(v.ttsServerVoice || '');
  }
);
ttsEl.addEventListener('change', () => chrome.storage.local.set({ tts: ttsEl.checked }));
ttsEngineEl.addEventListener('change', () => chrome.storage.local.set({ ttsEngine: ttsEngineEl.value }));
ttsModeEl.addEventListener('change', () => chrome.storage.local.set({ ttsMode: ttsModeEl.value }));
ttsLangEl.addEventListener('change', () => chrome.storage.local.set({ ttsLang: ttsLangEl.value }));
ttsLocalOnlyEl.addEventListener('change', () => chrome.storage.local.set({ ttsLocalOnly: ttsLocalOnlyEl.checked }));
ttsRateEl.addEventListener('input', () => {
  ttsRateVal.textContent = Number(ttsRateEl.value).toFixed(1);
  chrome.storage.local.set({ ttsRate: Number(ttsRateEl.value) });
});
ttsDebugEl.addEventListener('change', () => {
  chrome.storage.local.set({ ttsDebug: ttsDebugEl.checked }, () => {
    if (typeof refreshTtsStatus === 'function') void refreshTtsStatus();
  });
});
ttsVoiceEl.addEventListener('change', () => chrome.storage.local.set({ ttsVoice: ttsVoiceEl.value }));
ttsServerVoiceEl.addEventListener('change', () => chrome.storage.local.set({ ttsServerVoice: ttsServerVoiceEl.value }));

// Тест озвучки: просим content-скрипт активной вкладки произнести фразу —
// так отделяем проблему синтеза от проблемы событий/DOM.
const ttsTestBtn = document.getElementById('ttsTestBtn');
ttsTestBtn.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error(t('noTab'));
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'ocv-tts-test' });
    if (res && res.ok) {
      statusEl.textContent = t('testSent');
      statusEl.className = 'status ok';
    } else {
      statusEl.textContent = t('noContentScript');
      statusEl.className = 'status error';
    }
    setTimeout(refreshTtsStatus, 300);
  } catch (err) {
    statusEl.textContent = t('openPage');
    statusEl.className = 'status error';
  }
});

// Статус TTS с активной вкладки — быстрый способ диагностики без DevTools.
async function refreshTtsStatus() {
  const el = document.getElementById('ttsStatus');
  if (!el) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) { el.textContent = t('noTab'); return; }
    const s = await chrome.tabs.sendMessage(tab.id, { type: 'ocv-tts-status' });
    if (!s || !s.ok) { el.textContent = t('noStatus'); return; }
    // Галочка «Отладка» выключена — показываем одну строку вместо служебного
    // дампа. Раньше подробный вывод рисовался ВСЕГДА, и переключатель ничего
    // не делал: считалось, что настройка сломана.
    var wantDebug = false;
    try { wantDebug = (await chrome.storage.local.get({ ttsDebug: false })).ttsDebug === true; } catch (e) {}
    if (!wantDebug) {
      el.textContent = (s.gateOk && s.sourceState === 'open') ? t('ttsReady') : t('ttsWaiting');
      return;
    }
    el.textContent =
      `gate:${s.gateOk} sse:${s.sourceState} events:${s.events} fin:${s.finalized} rows:${s.rows} voices:${s.voices}\n` +
      `last:${s.lastType || '-'} sid:${(s.lastSid || '').slice(-8)}\n` +
      (s.lastSkip ? `skip:${s.lastSkip}\n` : '') +
      ((s.logTail && s.logTail.length) ? s.logTail.slice(-5).join('\n') : '');
  } catch (e) {
    el.textContent = t('statusNA');
  }
}
refreshTtsStatus();

beepTestBtn.addEventListener('click', async () => {
  try {
    await fetch(`${STT_SERVER}/beep?freq=880`, { headers: authHeaders() });
  } catch {
    statusEl.textContent = t('beepDown');
    statusEl.className = 'status error';
  }
});

async function checkServer() {
  try {
    const res = await fetch(`${STT_SERVER}/health`, { method: 'GET', headers: authHeaders() });
    if (res.ok) {
      let info = {};
      try { info = await res.json(); } catch {}
      statusEl.textContent = t('statusOk', { ver: info.version || '?', backend: info.backend || '?' });
      statusEl.className = 'status ok';
      const vEl = document.getElementById('versions');
      if (vEl) {
        const extV = chrome.runtime.getManifest().version;
        vEl.textContent = t('versions', { ext: extV, ver: info.version || '?', backend: info.backend || '?', device: info.device || '?' });
      }
      testBtn.disabled = false;
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    if (healing) {
      statusEl.textContent = t('statusWait');
      statusEl.className = 'status';
      return;
    }
    statusEl.textContent = t('statusDown', { err: err.message });
    statusEl.className = 'status error';
    testBtn.disabled = true;
  }
}

testBtn.addEventListener('click', async () => {
  testBtn.textContent = t('sttTesting');
  testBtn.disabled = true;

  try {
    // Create a tiny test audio (silence)
    const ctx = new AudioContext({ sampleRate: 16000 });
    const buffer = ctx.createBuffer(1, 16000, 16000); // 1 second silence
    const wav = bufferToWav(buffer);
    const blob = new Blob([wav], { type: 'audio/wav' });

    const formData = new FormData();
    formData.append('audio', blob, 'test.wav');

    const res = await fetch(`${STT_SERVER}/transcribe`, {
      method: 'POST',
      body: formData,
      headers: authHeaders(),
    });

    const result = await res.json();
    statusEl.textContent = t('testOk', { text: result.text || t('emptyResp') });
    statusEl.className = 'status ok';
  } catch (err) {
    statusEl.textContent = t('testErr', { err: err.message });
    statusEl.className = 'status error';
  } finally {
    testBtn.textContent = t('sttTest');
    testBtn.disabled = false;
  }
});

openBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id });
});

// Восстановление: /heal сбрасывает зависшую запись и перезапускает процесс
// (плагин-вотчдог поднимает сервер заново), затем ждём /health.
const healBtn = document.getElementById('healBtn');

async function waitForServer(timeoutMs) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const res = await fetch(`${STT_SERVER}/health`, { headers: authHeaders() });
      if (res.ok) {
        const info = await res.json().catch(() => ({}));
        statusEl.textContent = t('statusRestarted', { ver: info.version || '?', backend: info.backend || '?' });
        statusEl.className = 'status ok';
        testBtn.disabled = false;
        return true;
      }
    } catch {}
    statusEl.textContent = t('statusWaitSec', { sec: Math.round((Date.now() - started) / 1000) });
    statusEl.className = 'status';
  }
  statusEl.textContent = t('statusRestartFail');
  statusEl.className = 'status error';
  return false;
}

healBtn.addEventListener('click', async () => {
  healBtn.disabled = true;
  healBtn.textContent = t('healing');
  statusEl.textContent = t('healingServer');
  statusEl.className = 'status';
  healing = true;
  try {
    await fetch(`${STT_SERVER}/heal?restart=1`, { method: 'POST', headers: authHeaders() });
  } catch {
    // сервер мог не успеть ответить — всё равно ждём восстановления
  }
  await waitForServer(60000);
  healing = false;
  healBtn.disabled = false;
  healBtn.textContent = t('heal');
});

function bufferToWav(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;

  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = buffer.length * blockAlign;
  const headerSize = 44;
  const totalSize = headerSize + dataSize;

  const arrayBuffer = new ArrayBuffer(totalSize);
  const view = new DataView(arrayBuffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, totalSize - 8, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // chunk size
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Write samples
  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      view.setInt16(offset, sample * 0x7FFF, true);
      offset += 2;
    }
  }

  return arrayBuffer;
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// Recheck every 10 seconds (первая проверка — после загрузки настроек, см. выше)
setInterval(checkServer, 10000);