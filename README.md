# dsh-device-fleet

One cockpit for Android phones and emulators inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): list the fleet, install a build on two phones, wipe one app's data, deep-link the same URL everywhere, grab screenshots, and tail exactly the logs you need — all from the agent or the Web UI, over adb.

`dsh-device-fleet` is a generic, OSS DSH plugin. It has no application-specific dependencies and no network access: it drives the `adb` already installed on your machine.

## Why

A two-phone test loop is usually a pile of terminals and carefully copied serials. This plugin gives the agent (and you) one predictable tool surface:

- **No guessing.** With more than one device connected, action tools refuse to pick one and list the serials instead.
- **No hangs.** Every adb call has a hard timeout (10 s default, 20 s install, 15 s screenshot/logcat) and bounded output.
- **No silent failures.** Missing adb, unauthorized devices, offline devices, install failures, and blocked commands return actionable `{ ok: false, code, error, hint }` results.
- **Approval-gated side effects.** Install and clear-data ask for approval; listing, screenshots, logcat, and pulls never prompt.
- **Read-only UI.** Device cards render inside the conversation for `fleet_list`, screenshots, and logcat; actions stay on the audited tool path.

## Requirements

| Requirement | Notes |
|---|---|
| DeepSeek Harness | `>= 0.2.2-rc.1` (declared as `engines.dsh`) |
| Node.js | 24+ (ships with DSH) |
| Android platform-tools | `adb` on `PATH`, or an Android SDK discoverable through `ANDROID_HOME` / `ANDROID_SDK_ROOT` |
| Devices | Android 8+ phones with USB debugging, and/or Android emulator AVDs |
| OS | Windows 10/11 first-class; macOS and Linux supported |

## Install

### From a local checkout (recommended while the plugin is pre-npm)

Ask the agent to install the bundle from this directory, or use the plugin manager in the Web UI:

```text
plugin_manager install_bundle  target: D:\Projects\dsh-plugins\dsh-device-fleet
```

The plugin manager links the checkout into the current profile and inserts the bundle row. Restart DSH if the manager reports `restart-required`.

### Manual profile patch

`plugin_manager` is the supported path, but the bundle is a normal profile patch, so this row in your profile's `cordis.patch.yml` also works:

```yaml
- insert:
    - id: dsh-device-fleet
      name: '@darkmintis/dsh-device-fleet'
      config: {}
```

### Verify

```text
device_which()
fleet_list()
```

`device_which` reports how adb, the Android SDK, the emulator, Java, and Flutter resolved. `fleet_list` shows every connected phone/emulator. With the Web UI open you also get a `Device fleet` entry in the plugin list with its icon and localized title/description.

## Quick start: the two-phone loop

```text
fleet_list()                                            # note the two serials
device_install(serial: "R58M12345", apkPath: "C:/build/app-debug.apk")
device_install(serial: "emulator-5554", apkPath: "C:/build/app-debug.apk")
device_clear_data(serial: "R58M12345", packageName: "com.example.app")   # approval prompt
device_deep_link(serial: "R58M12345", url: "myapp://test/upload")
device_deep_link(serial: "emulator-5554", url: "myapp://test/upload")
device_screenshot(serial: "R58M12345")                  # host PNG path for read_image
device_screenshot(serial: "emulator-5554")
device_logcat(serial: "R58M12345", preset: "upload", filter: "failed")
device_logcat(serial: "emulator-5554", preset: "upload", filter: "failed")
```

Every tool that acts on a device accepts `serial`. Switching between a phone and an emulator never changes the loop.

## Right-sidebar device fleet

Installing the bundle adds a **Devices tab to the right Sidebar** (the same column
as Files, Browser, and Terminal). Open it from the small device icon in the Session
header utilities, or from the right Sidebar's **+** guide and its "Devices" entry.

- Cards show model, serial, state, Android version, and battery. Click a card to
  tick that device; **Select all** / **None** manage the set. The destructive
  clear-data action stays on the approval-gated tool, not in the overlay.
- **Relaunch**, **Stop**, **Screenshot**, **Logs**, and **Mirror** run on every
  ticked device; **Restart ADB** recovers a stale adb server without a terminal. The app is resolved from each device's foreground
  activity, so there is no package or APK field to fill in.
- **Mirror** opens one read-only scrcpy window per ticked device (`--no-control`);
  input stays on the phone, so the mirror is visible while the tab remains your
  control surface. scrcpy is discovered from `SCRCPY`, `PATH`, or the WinGet
  package directory. When it is missing the button stays disabled and tells you how
  to install it.
- The tab lives in the session's right column and persists across Sessions like the
  shipped tabs; the floating overlay and its launcher are retired.
- The log viewer streams bounded logcat snapshots per device with the same
  `flutter` / `crash` / `upload` / `all` presets and filter as the tools.
- The overlay polls only while it is open and talks to the Host through the same
  authenticated same-origin connection as the rest of the Web UI; the Host route
  rejects requests that fail the connection trust fence. Clear-data asks for a
  browser confirmation first.

The overlay and the agent tools share one service layer, so an overlay action
produces exactly the same validation, error shape, and side effects as a tool
call. The Host route is registered only in profiles that compose the Web server
and connection services; headless profiles keep the tools.

> Upgrading a bundle updates the Host half when the app starts, so quit and
> restart DeepSeek Harness once after installing a new version.
## Tool reference

All tools return JSON. Failures are always `{ ok: false, code, error, hint?, details? }` and are rendered as readable text for the model.

| Tool | Arguments | Approval | Returns |
|---|---|---|---|
| `fleet_list` | `serial?`, `packageName?` | — | Devices with state, model, Android version, SDK, battery %, screen on/off, emulator flag, adb path, and optional `versionName`/`versionCode`. |
| `device_install` | `apkPath` (required), `serial?` | ✅ | Installs/replaces an APK (`adb install -r`) after validating the path and ZIP signature. |
| `device_launch` | `packageName` (required), `serial?` | — | Resolves the launcher activity, then `am start -n <component>`. |
| `device_stop` | `packageName` (required), `serial?` | — | `am force-stop`. |
| `device_clear_data` | `packageName` (required), `serial?` | ✅ | `pm clear`; confirms `Success`. |
| `device_screenshot` | `serial?` | — | `exec-out screencap -p` → PNG under the plugin temp dir; returns absolute path, bytes, dimensions. |
| `device_logcat` | `serial?`, `preset` (`flutter`/`crash`/`upload`/`all`), `filter?`, `lines` (1-2000, default 200) | — | Bounded snapshot (`logcat -d -t 4000`), filtered and tailed; returns matched/total counts and lines. |
| `device_deep_link` | `url` (required), `serial?` | — | `am start -a android.intent.action.VIEW -d <url>` after URL validation. |
| `device_shell` | `serial` (required), `command` (required) | ✅ | One allowlisted command (`pm`, `am`, `dumpsys`, `settings`, `input`, `screencap`, `getprop`, `wm`, `svc`, `cmd`, `ping`) with metacharacters rejected. |
| `device_pull` | `remotePath` (required), `serial?` | — | `adb pull` into the plugin temp dir; returns the host path. |
| `device_which` | — | — | Resolved `adb`, Android SDK, emulator, Java, Flutter paths and versions. |
| `emulator_start` | `avdName` (required) | — | Boots one AVD detached; returns the new PID and a poll hint. |
| `emulator_stop` | `serial` (required) | — | `adb -s <emulator> emu kill`; refuses non-emulator serials. |

### Logcat presets

| Preset | Matches |
|---|---|
| `flutter` | `E/flutter`, `FATAL EXCEPTION`, `Unhandled Exception`, Flutter error/exception lines |
| `crash` | `FATAL EXCEPTION`, `ANR in`, `am_crash`, `beginning of crash`, `FATAL` |
| `upload` | Lines mentioning `upload` (combine with `filter` to isolate failures) |
| `all` | Everything in the captured window |

`device_logcat` is always a snapshot: it never streams, caps the device read at 4000 lines, caps the returned tail at `lines`, and times out after 15 s.

## Security and permissions

- **No telemetry, no network calls.** The plugin only executes `adb` (and, for `emulator_start`, the local Android emulator binary). Nothing is sent anywhere.
- **No arbitrary command execution.** `device_shell` is allowlisted to 11 inspection/automation commands and rejects shell metacharacters, quotes, globbing, and redirection before adb is invoked. The other tools pass fixed argv arrays; no shell is involved.
- **Approval on side effects.** `device_install`, `device_clear_data`, and `device_shell` ask the harness approval service before running (fail-closed when approvals are unavailable). Read-only tools never prompt.
- **Files it reads:** the APK path you pass (existence + ZIP signature); adb's stdout/stderr.
- **Files it writes:** screenshots and pulled files under `%TEMP%/dsh-device-fleet/` (or the OS temp dir). Screenshots older than 24 h are pruned on the next capture; nothing else is persisted.
- **No secrets.** Logs and results contain serials, package names, and adb output — never credentials.

See [SECURITY.md](SECURITY.md) for the reporting process.

## Screenshots

> _Placeholder — add a GIF of the two-phone install/logcat loop and a screenshot of the device cards after the first tagged release._

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ADB_NOT_FOUND` | Install Android platform-tools (Android Studio → SDK Manager → SDK Tools) or set `ANDROID_HOME` to the SDK root; `adb` lives in `<sdk>/platform-tools`. Then rerun `device_which`. |
| `SERIAL_REQUIRED` with a device list | More than one device is connected. Pass `serial` from the list; the plugin deliberately never guesses. |
| `DEVICE_UNAUTHORIZED` | Unlock the phone and tap **Allow USB debugging** (tick "Always allow"), then retry. |
| `DEVICE_OFFLINE` | Reconnect the cable, or restart the emulator; run `fleet_list` again. |
| `ADB_TIMEOUT` | The device is busy or asleep. Unlock it and retry; installs get 20 s, screenshots/logcat 15 s, everything else 10 s. |
| Screenshot fails on a secure screen | Apps using `FLAG_SECURE` cannot be captured. Take the screenshot on a non-secure screen. |
| `keeps saying no devices` | The adb server may be wedged: run `adb kill-server` in a terminal, then retry. The plugin also retries once with `adb start-server`. |
| Windows: adb found in a terminal but not by DSH | The DSH host process may have a different `PATH`; set `ANDROID_HOME` (machine or user environment variable) and restart DSH. |

## Development

```bash
npm install          # dev dependencies only (typescript, @types/node)
npm run typecheck    # tsc --checkJs over the Host half
npm run lint         # security invariants + client import rules
npm test             # 90+ unit/integration tests (fake adb, no device needed)
npm run build        # manifest/asset/runtime import checks
node scripts/smoke.mjs   # optional: probe this machine's real adb setup
```

Tests are deterministic and never touch real hardware: `tests/fixtures/fake-adb-handler.mjs` scripts adb output, and the production runner executes it through an in-memory ChildProcess seam. `tests/fixtures/fake-adb.mjs` is the same script as a real executable for manual runner debugging.

## Known limitations (v0.1.0)

- No video capture, no Play Console, no remote networking (out of scope for v1).
- No broadcast "install on every device" helper: one call per device keeps approvals and failures attributable.
- **Build commands are not driven from the overlay yet.** Ticking devices does not
  rewrite `flutter run` / Gradle invocations: those are host build commands, not
  device commands. The overlay covers installed-app actions (relaunch, stop,
  screenshot, logcat, mirror); a projected "dev task" runner would need a
  project-folder source and long-running-process handling.
- `device_launch` requires a launcher activity; service-only apps have no launcher
  activity to resolve.
- Mirroring requires scrcpy; without it the overlay shows install guidance instead
  of failing an action.
- adb output caps: 4 MB text, 32 MB binary; logcat device read capped at 4000 lines.

## License

MIT © 2026 Darkmintis. See [LICENSE](LICENSE).
