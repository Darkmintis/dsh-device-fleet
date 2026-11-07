# Contributing to dsh-device-fleet

Thanks for helping. This plugin values a small, predictable surface over feature count.

## Setup

```bash
git clone https://github.com/Darkmintis/dsh-device-fleet.git
cd dsh-device-fleet
npm install
npm run typecheck && npm run lint && npm test && npm run build
```

Tests never need a device: `tests/fixtures/fake-adb-handler.mjs` scripts every adb response. If you want to try real hardware, run `node scripts/smoke.mjs` with a phone or emulator connected.

## Ground rules

- Read [AGENTS.md](AGENTS.md) first — its invariants are enforced by `npm run lint` and CI.
- New tools need: a precise description (≤16 words), a strict argument schema, a service method, fake-adb tests, an approval decision (read-only vs. ask), and a README row.
- Keep the Web client half read-only unless the plugin gains a supported Host Remote namespace; never fake an approval or an action.
- No telemetry, no network calls, no shell interpolation, no machine-specific paths.
- Conventional commits, one logical change per commit.

## Pull requests

1. Fork, branch from `main`, make your change.
2. Run the four gates above; add tests for every error path you touched.
3. Describe the user-visible behavior change and how you verified it (fake adb is fine; real hardware notes are welcome).
4. Do not bump the version or edit `CHANGELOG.md` release dates — maintainers handle releases.

## Reporting bugs

Open an issue with the tool name, the exact arguments, the returned `code`/`error`/`hint`, your OS, DSH version, and `device_which` output (redact serials if they are sensitive).
