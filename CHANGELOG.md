## [Unreleased]

### Added

- **Device fleet panel**: a sidebar entry and main-column cockpit in the Web UI
  showing every connected phone/emulator with launch, stop, clear-data,
  screenshot, install, deep-link, and bounded logcat actions across all devices
  at once.
- **Panel HTTP API** (`/dsh-device-fleet/api/`) registered through the Web server
  and admitted by the connection trust fence: devices, logs, screenshots (PNG),
  and multi-device actions. The API is absent in headless profiles.
- Panel API tests: unauthenticated rejection, structured payloads, multi-device
  fan-out, per-device install failure, log aggregation, PNG streaming, and error
  shapes.
# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-11-08

### Added

- Initial DSH profile bundle: Host tools plus a read-only Web client half.
- `fleet_list`: device/emulator inventory with state, model, Android version, SDK, battery, screen, emulator flag, adb path, and optional package `versionName`/`versionCode`.
- `device_install` (approval-gated, APK validation), `device_launch`, `device_stop`, `device_clear_data` (approval-gated).
- `device_screenshot`: PNG capture into the plugin temp dir with 24 h pruning.
- `device_logcat`: bounded snapshot with `flutter`, `crash`, `upload`, `all` presets plus substring filter.
- `device_deep_link`, `device_pull`, `device_which`.
- `device_shell` (approval-gated): 11-command allowlist and shell-metacharacter rejection.
- `emulator_start` / `emulator_stop`.
- Multi-device disambiguation: never guesses; returns the device list with `SERIAL_REQUIRED`.
- Actionable failures for missing adb, unauthorized/offline devices, timeouts, and install failures; automatic `adb start-server` retry once.
- Read-only conversation cards for device listings, screenshots, and logcat.
- Unit + fake-adb integration tests, CI (Node 24), and a manual smoke script.

### Changed

- The panel is now a **device gateway**: click cards to select devices, then
  **Relaunch / Stop / Screenshot / Logs / Clear data** act on the whole selection.
  Package, APK, deep-link inputs and the adb/SDK path line are gone; the app is
  resolved from each device's foreground activity.
- Removed the `device_shell` tool (and its approval gate). Fixed-argv adb actions
  remain; no arbitrary device shell is exposed.

### Fixed

- Tool results are normalised to lossless JSON (no `undefined`/`NaN` values), so every result satisfies the Harness output validator.
- Device listings report whether the adb server had to be started, and the Web client surfaces adb warnings in the fleet card.

[0.1.0]: https://github.com/Darkmintis/dsh-device-fleet/releases/tag/v0.1.0
