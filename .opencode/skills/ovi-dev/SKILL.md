---
name: ovi-dev
description: Use when developing or releasing OpenCode Voice — typecheck, pytest, sync-plugin.sh, CI workflow, version bumps, commit/push conventions, README/AGENTS/AUDIT updates, and distribution (ecosystem PR, npm, Chrome Web Store). Triggers build, tests, CI, release, commit, version bump, publish, docs.
license: MIT
compatibility: opencode
metadata:
  author: Di1r1
  audience: maintainers
  workflow: release
---

# OpenCode Voice — V2 development and release

## Repository and entrypoints

Project root: `<PROJECT_ROOT>`.

- Server source: `src/index.ts`.
- Loaded server copy: `.opencode/plugins/voice/index.ts`.
- TUI source/loaded copy: `src/tui.tsx` and `.opencode/plugins/voice/tui.tsx`.
- Extension: `extension/`; current bundle version `1.0.34`.
- STT server: `stt-server/stt_server.py`.
- V2 migration evidence: `V2_MIGRATION.md`.

The server plugin is a plain object `{ id: "voice", setup(ctx) }` without a value-import of
`@opencode/plugin`. Commands are registered by `ctx.command.transform`; the TUI invokes the
registered `voice` command. Do not add a duplicate config command or document editor insertion
as the V2 result: the current command sends text to the session/model.

## Change → verify loop

Run commands from `<PROJECT_ROOT>`:

```bash
cd <PROJECT_ROOT>
bash sync-plugin.sh
bash sync-plugin.sh --check
PATH=/tmp/node-v22.23.3-linux-x64/bin:<V1_PROJECT_ROOT>/node_modules/.bin:$PATH npm run typecheck  # project-local: untrusted/no-op
python3 -m py_compile stt-server/stt_server.py
python3 -m pytest
PATH=/tmp/node-v22.23.3-linux-x64/bin:$PATH npm test
```

The check loop has important limits:

- `sync-plugin.sh` supplies the whole bundle (19 files): entrypoints, `src/lib/*.ts`,
  `stt-server/`, `shared/`, `doctor.sh`, `fix-mic.sh`; `--check` prints per-file `OK`/`FAIL`
  and exits `1` on drift. `test/deploy.test.mjs` asserts the shipped bundle is self-sufficient
  from a foreign temp cwd.
- The V2 launcher resolves `stt-server/stt_server.py`, `doctor.sh` and `shared/stt-spec.json`
  relative to the bundle as well as the sources, so autostart works from any service cwd.
  A live check of the *running* process path against the real service cwd is still worth doing.
- `npm run dev` runs the current package script `opencode` (there is no `--plugin .` argument in
  the current script).
- `PATH=/tmp/node-v22.23.3-linux-x64/bin:$PATH npm test` is recorded at **93/93** on Node
  `22.23.3` (13 of them cover the shell argv boundary, 4 the shipped bundle); `pytest` at **65/65**. Default Node `v18` is not sufficient for the
  `--experimental-strip-types` test script, and `package.json.engines.node >=20` does not
  describe the actual prerequisite; engines/CI correction is a future code/config task.
- `PATH=/tmp/node-v22.23.3-linux-x64/bin:<V1_PROJECT_ROOT>/node_modules/.bin:$PATH npm run typecheck`
  (underlying `tsc --noEmit`) in the V2 checkout is currently untrusted/no-op: local
  dependencies are absent and the 0-byte executable shim does not run TypeScript.
- A separate external-dependency check did run real TypeScript directly with Node 22:
  `<V1_PROJECT_ROOT>/node_modules/typescript/bin/tsc` plus temporary
  `<EXTERNAL_TYPECHECK_CONFIG>` (typeRoots/paths to V1 dependencies), exit `0`.
  This is not autonomous V2 validation; install local dependencies and replace the no-op runner.
- `bash sync-plugin.sh --check` covers all 19 bundled files, but it still does not prove that a
  *live* STT process on the real service cwd is the bundle's copy; use `/voice doctor` + `ps`.

The runtime/server tests are hermetic: they do not require a microphone or a model. Live PTT,
button and doctor checks are separate manual tests in `TEST_PLAN.md`.

## Config and restart rules

Plugin, TUI and config-time artifacts are loaded at startup. After changing them, restart
OpenCode and the TUI/service client before judging live behavior. A stale TUI client may retain
prior state, but that is only a possible applied cause unless a log proves it.

The STT server binds `127.0.0.1` by default and CORS is local-only. `OPENCODE_VOICE_TOKEN` is
optional: `/health` is public, while other endpoints require the token when configured. Never
copy tokens or API keys into docs, skills, tests or commits.

## CI and test layout

The V2 repository has separate plugin and server concerns:

- plugin checks: Node, `PATH=/tmp/node-v22.23.3-linux-x64/bin:$PATH npm test`, typecheck (with a local TypeScript dependency in a clean CI
  environment), and `sync-plugin.sh --check`;
- server checks: Python, requirements-dev installation, `py_compile`, and `pytest`.

Shared STT/TTS cases live under `shared/`. Server tests live under `stt-server/tests/` and are
hermetic. A CI result should record the actual executable/source of TypeScript rather than
silently borrowing another checkout's `node_modules`.

## Versioning

- Extension: bump `extension/manifest.json` and the `content.js` console string together. The
  current pair is `1.0.34`.
- Plugin package: `package.json` version is currently `0.5.0`.
- Loaded plugin is not hot-reloaded; restart OpenCode after a version/config change.
- The current migration is not an autonomous release/deployment: the STT process path and
  resource packaging gap must be recorded in release notes until fixed.

## Docs/status sources

| File | Required content |
| --- | --- |
| `V2_MIGRATION.md` | Текущий canonical status/evidence для V2: матрица, semantic difference, deployment gap, counts и remaining tasks |
| `AGENTS.md` | V2 entrypoint, loaded path, prompt semantics, auth, tests and restart rules |
| `TEST_PLAN.md` | Root-relative V2 smoke checks, 76/65 counts, live behavior and known gap |
| `SKILLS_GUIDE.md` | Native V2 `skills` array, current paths/count and current ignore status |
| `extension/README.md` | Bundle `1.0.34`, root-relative commands, `127.0.0.1`, CPU `small` default |
| `README.md` / `README.ru.md` / `AUDIT.md` | В `openvi2` эти файлы отсутствуют; не считать их синхронизированными и не опираться на них как на canonical source |

Текущий canonical status/evidence — `V2_MIGRATION.md`. Не публиковать и не коммитить отчёт,
который превращает неподтверждённую live-проверку в успешную. Mark
physical `<leader>v`, deployment path and optional TTS separately.

## House style

- Documentation and code comments should explain non-obvious **why**, not narrate trivia.
- Keep paths exact and distinguish project root, loaded bundle and V1 evidence paths.
- Recordings and logs stay in `/tmp` or `/dev/shm`; never commit them.
- Never commit secrets; use placeholders in examples.
- Before an external release, run a sensitive-data scan over files and history.

## Distribution status

Distribution remains separate from V2 migration completion: ecosystem/npm/Chrome publication
steps require their own review and are not evidence that the local V2 deployment gap is closed.
