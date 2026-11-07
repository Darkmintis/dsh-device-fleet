# Security policy

## Design posture

dsh-device-fleet is a local developer tool. It is deliberately small and auditable:

- **No telemetry. No network access.** The plugin does not fetch, upload, or transmit anything. Its only outbound actions are local `adb` commands and the local Android emulator binary.
- **No arbitrary command execution.** `device_shell` accepts only 11 allowlisted first words (`pm`, `am`, `dumpsys`, `settings`, `input`, `screencap`, `getprop`, `wm`, `svc`, `cmd`, `ping`) and rejects shell metacharacters, quotes, globbing, and redirection before invoking adb. All other tools pass fixed argv arrays.
- **Approval-gated side effects.** `device_install`, `device_clear_data`, and `device_shell` request harness approval before execution and fail closed when no approver is available. Read-only tools never prompt.
- **Bounded execution.** Every adb call has a hard timeout (10 s default, 20 s install, 15 s screenshot/logcat) and bounded output, so a wedged device cannot hang the host.
- **Ephemeral files only.** Screenshots and pulled files are written under the OS temp directory (`dsh-device-fleet/`), and screenshots older than 24 hours are pruned. No configuration or credentials are persisted.

## What it reads

- The APK path supplied to `device_install` (existence and ZIP signature only).
- `adb` stdout/stderr, `emulator -list-avds` output, and the local Android SDK layout (for discovery).
- Environment variables used for discovery: `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `LOCALAPPDATA`, `USERPROFILE`, `JAVA_HOME`, `PATH`.

## What it writes

- PNG screenshots and pulled device files under `<temp>/dsh-device-fleet/`.
- Nothing in the DSH profile, the workspace, or the repository.

## What it executes

- `adb` (install, launch, stop, clear, shell, logcat snapshot, screencap, pull, emu kill, start-server, devices).
- `emulator -list-avds` and a detached `emulator -avd <name>` only when `emulator_start` is called.

## Reporting a vulnerability

Please report security issues privately to the repository owner (GitHub: [@Darkmintis](https://github.com/Darkmintis)) rather than opening a public issue. Include the plugin version, the tool invoked, and the arguments. Do not include device data. You can expect an acknowledgement within a few days.

## Scope

Out of scope: physical device compromise, adb's own vulnerabilities, and data already accessible to a local user with adb authorization. In scope: command injection through tool arguments, approval-gate bypasses, unbounded resource use, and accidental disclosure through tool output.
