---
name: ovi-extension
description: Use when working with the OpenCode Voice Chrome extension or the mic button — manifest, content.js, popup token, beeps toggle, X-Voice-Source header, CORS failures ("Failed to fetch"), version bumps and extension reload. Triggers extension, chrome://extensions, mic button, popup, voice button, content.js, Failed to fetch (button).
license: MIT
compatibility: opencode
metadata:
  author: Di1r1
  audience: both
  workflow: capture
---

# OpenCode Voice — Chrome extension (the "button")

Directory: `<PROJECT_ROOT>/extension/` (MV3). Files: `manifest.json`, `content.js`, `content.css`, `popup.html`,
`popup.js`, `icon.svg`, `README.md`. Current version **1.0.34** (also printed in the console as
`[OpenCode Voice] content.js v1.0.34 loaded`).

## Flow

1. Content script injects a mic button into the OpenCode web UI (origin `http://127.0.0.1:4096`).
2. On press: `GET /beep?freq=880` → `navigator.mediaDevices.getUserMedia` → `MediaRecorder` (WebM/Opus).
3. On stop: `GET /beep?freq=520` → `POST /transcribe` (multipart) → `GET /beep?freq=660` on success.
4. The transcript is inserted into the prompt.

All requests to the server carry:
- `X-Voice-Source: button` (tags the transcript in `voice-recognized.log`), and
- `X-Voice-Token: <token>` when a token is configured in the popup.

`GET /beep?freq=0` on load is a version ping marker.

## Popup

- **Token** field — stored in `chrome.storage.local`; must equal the server's `OPENCODE_VOICE_TOKEN`, otherwise the server answers `401`.
- **Sound toggle** — `chrome.storage.local.beeps`; content script listens to `chrome.storage.onChanged`.
- **Test sound** button — plays a beep through the server.

Sounds are played by the **server** (`/beep` → `aplay -D pulse` → `paplay` → `ffplay`), not in the browser
(browser autoplay policy blocked Web Audio).

## Critical: CORS

Adding a custom header (`X-Voice-Source`) makes requests non-simple, so the browser sends a
preflight `OPTIONS`. The server must answer with

```
Access-Control-Allow-Headers: Content-Type, X-Voice-Token, Authorization, X-Voice-Source
```

If the running server predates that header, **every button request fails with `Failed to fetch`**.
Fix: restart the server (`./doctor.sh --fix` or just restart it) — see `ovi-debug`.

## Reload / versioning

1. Bump `"version"` in `manifest.json` **and** the `content.js` console string.
2. `chrome://extensions` → Developer mode → **Reload**; then hard-refresh the OpenCode page (F5).
   Without the reload Chrome keeps the old `content.js`, which has caused "no sounds" and stale behaviour.

## Related UI

- `.opencode/plugins/voice/tui.tsx` — TUI-часть V2 (грузится автоматически с плагином):
  хоткей `<leader>v` вызывает серверную команду через
  `context.client.session.command({ sessionID, name: "voice", text: "/voice" })`; `🎤` в
  `prompt.footer.status` — только индикатор, не кликабельная кнопка.

## Constraints

- **Scope is least-privilege (P0 fixed, v1.0.35).** `content_scripts.matches` now contains only
  `http://localhost:*/*` and `http://127.0.0.1:*/*`; `<all_urls>` is removed. The STT target is
  no longer derived from `location.hostname`: `content.js` keeps `sttHost` only for
  `TRUSTED_STT_HOSTS` (`localhost`, `127.0.0.1`, `::1`) and `popup.js` resolves a stored host
  through `trustedSttHost()`, which returns `127.0.0.1` for loopback and `''` otherwise. Keep
  this invariant if matches are widened: re-run the manifest/store review.
- **Known manifest defect (not yet fixed).** `host_permissions` still contains
  `172.16.0.0/12` and `192.168.0.0/16`, which are invalid Chrome match patterns. Replace with
  valid patterns or drop them.
- **After bumping the version**, reload the extension in `chrome://extensions`, otherwise the
  browser keeps the old bundle.
- The extension talks to `http://127.0.0.1:8765` by default; a different port/host requires editing
  `STT_HOST`/port in `content.js` / `popup.js`. The V2 local bundle currently has a server-resource
  deployment gap, so verify `/health` and the process path before diagnosing the button.
