# AGENTS.md — invariants for dsh-device-fleet

Read this before changing the plugin. It describes the rules that keep the plugin safe and the harness contract that keeps it loadable.

## Repository layout

```text
index.js              Host plugin entry: apply(ctx), inject = ['tools']
cordis.patch.yml      Profile bundle patch (one insert row)
lib/adb.js            adb/emulator process runner plus the detached scrcpy launcher: spawn, capture, timeout, start-server retry
lib/parse.js          Pure parsers for adb/getprop/dumpsys/logcat output
lib/platform.js       Runtime discovery of adb, SDK, emulator, java, flutter, scrcpy
lib/service.js        Fleet operations + serial disambiguation + timeout mapping
lib/tools.js          Tool definitions (name/description/schema/render/execute) + approval gate
lib/args.js           Typed argument validation and JSON-schema projection
lib/errors.js         Stable success/failure envelopes
lib/logcat.js         Presets and bounded filtering
lib/screenshot.js     PNG capture + 24 h temp cleanup
lib/render.js         Human-readable text for every result
client.js             Web client half: read-only tool cards (loaded via __ModuleLoader__)
locales, icon.svg     Display metadata for Plugin Manager / Settings
tests/                node:test unit + fake-adb integration tests
scripts/              lint, build-check, manual smoke
```

## Hard invariants

1. **No shell.** adb, the emulator, and the scrcpy mirror are always spawned with an argv array and `shell: false`. `child_process` may only be imported by `lib/adb.js` (enforced by `npm run lint`); the scrcpy launcher there is detached, fixed-argv, and passes `--no-control`.
2. **Bounded everything.** Every process call has a timeout and an output cap. logcat is a snapshot; never stream.
3. **No telemetry, no network.** The Host half must not call `fetch`, `http`, `https`, or any remote service.
4. **Approval on side effects.** Only `device_install` and `device_clear_data` may request approval, via a `tools/pre-execute` waterfall returning `{ kind: 'ask', reason }`. Read-only tools must call `next()`. Never bypass the approval service. The overlay gateway and the mirror action do not require approval: they never mutate app state.
5. **No guessing.** When more than one ready device exists, action tools return `SERIAL_REQUIRED` with the device list. Do not add auto-selection.
6. **Stable errors.** Tools never throw raw errors at the model; they return `{ ok: false, code, error, hint?, details? }` with an actionable hint. Codes live in `lib/errors.js`.
7. **Typed inputs.** Every tool validates its arguments (`additionalProperties: false`, enum/bounds/type checks) before running adb.
8. **The Web client imports only React.** No `@deepseek-ai/*` requires, no DOM writes outside the component, colors only via `--dsw-alias-*` tokens.
9. **No machine-specific paths or secrets committed.** Discovery happens at runtime; tests use the injected fake adb.
10. **Windows-first.** Use `node:path` and normalize paths; never hard-code `/` separators into filesystem writes.

## Commands

```bash
npm run typecheck   # tsc -p tsconfig.json (checkJs)
npm run lint        # security invariants + client import rules
npm test            # node --test --test-isolation=none "tests/**/*.test.mjs"
npm run build       # manifest/asset/runtime checks
npm run smoke       # manual probe of the real machine (optional)
```

`npm test` must pass without a connected device. If you add a tool, add: an entry in `lib/tools.js`, a service method, a parser/unit test for any new parsing, an integration test through the fake adb, and a README row.

## Harness contract (DSH 0.2.2-rc.1)

- The package is a profile bundle: `dsh.bundle.patch` → `cordis.patch.yml`.
- `index.js` exports `apply(ctx)` and `inject = ['tools']`.
- Tools are registered through `ctx.tools.register(definition)` wrapped in `ctx.effect()`; the definition needs `description` (≤16 words), `parameters` (JSON schema object, `additionalProperties: false`), `output: { schema, render }`, and `execute`.
- Approval is a `tools/pre-execute` waterfall listener: `next()` for read-only, `{ kind: 'ask', reason }` for side effects.
- The client half is declared with `dsh.client` + `exports["./client"]` and loads via `window.__ModuleLoader__.load({ id, factory(require) })`.
- `engines.dsh` is enforced by the plugin manager; keep it in sync with the supported Harness range.

## Commit style

Conventional commits, one logical change per commit (`feat:`, `fix:`, `test:`, `docs:`, `ci:`, `chore:`). Do not commit `node_modules/`, screenshots, or machine-specific absolute paths.
