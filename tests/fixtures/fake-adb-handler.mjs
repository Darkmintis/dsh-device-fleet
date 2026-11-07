/**
 * Scripted adb behavior shared by the in-process test double and the real
 * `fake-adb.mjs` executable.
 *
 * `runFakeAdb(argv, env)` receives the argument vector *after* the adb
 * executable (including a leading `-s <serial>`), and returns what a real adb
 * process would print and exit with. Scenario selection comes from
 * `FAKE_ADB_SCENARIO`; the no-server scenario uses `FAKE_ADB_STATE_DIR` for its
 * one-shot marker.
 *
 * @module
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 1x1 transparent PNG. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const DEVICES = {
  single: 'List of devices attached\nR58M12345\tdevice usb:1-1 product:beyond1ltexx model:SM_G973F device:beyond1 transport_id:3\n',
  multi:
    'List of devices attached\nR58M12345\tdevice usb:1-1 product:beyond1ltexx model:SM_G973F device:beyond1 transport_id:3\n' +
    'emulator-5554\tdevice product:sdk_gphone_x86 model:sdk_gphone_x86 device:generic_x86 transport_id:4\n',
  mixed:
    'List of devices attached\nR58M12345\tdevice usb:1-1 product:beyond1ltexx model:SM_G973F device:beyond1 transport_id:3\n' +
    'emulator-5554\tdevice product:sdk_gphone_x86 model:sdk_gphone_x86 device:generic_x86 transport_id:4\n' +
    'ABC123\tunauthorized usb:1-2 transport_id:5\n',
  unauthorized: 'List of devices attached\nABC123\tunauthorized usb:1-2 transport_id:5\n',
  offline: 'List of devices attached\nXYZ789\toffline transport_id:6\n',
  none: 'List of devices attached\n\n',
};

const PROPS_PHONE =
  '[ro.product.model]: [SM_G973F]\n' +
  '[ro.product.manufacturer]: [samsung]\n' +
  '[ro.product.device]: [beyond1]\n' +
  '[ro.build.version.release]: [13]\n' +
  '[ro.build.version.sdk]: [33]\n' +
  '[ro.kernel.qemu]: []\n';

const PROPS_EMULATOR =
  '[ro.product.model]: [sdk_gphone_x86]\n' +
  '[ro.product.manufacturer]: [Google]\n' +
  '[ro.product.device]: [generic_x86]\n' +
  '[ro.build.version.release]: [14]\n' +
  '[ro.build.version.sdk]: [34]\n' +
  '[ro.kernel.qemu]: [1]\n';

const LOGCAT_LINES = [
  '07-01 10:00:00.000  1234  1234 I flutter : app started',
  '07-01 10:00:01.000  1234  1234 E flutter : Unhandled Exception: boom',
  '07-01 10:00:02.000  2222  2222 I UploadWorker: starting upload of /tmp/a.jpg',
  '07-01 10:00:03.000  2222  2222 E UploadWorker: upload failed: 413 payload too large',
  '07-01 10:00:04.000  3333  3333 D unrelated: noise line',
  '07-01 10:00:05.000  4444  4444 F DEBUG: FATAL EXCEPTION: main',
  '07-01 10:00:06.000  4444  4444 F DEBUG: ANR in com.example.app',
];

/**
 * @typedef {object} FakeAdbResult
 * @property {string | Buffer} [stdout] Standard output.
 * @property {string} [stderr] Standard error.
 * @property {number} [code] Exit code, default 0.
 * @property {boolean} [hang] When true the fake process never exits.
 */

/**
 * Execute one scripted adb command.
 *
 * @param {readonly string[]} argv Arguments after the executable, including any `-s <serial>`.
 * @param {NodeJS.ProcessEnv} env Scenario environment.
 * @returns {FakeAdbResult} scripted process result.
 */
export function runFakeAdb(argv, env) {
  const scenario = env.FAKE_ADB_SCENARIO ?? 'single';
  const stateDir = env.FAKE_ADB_STATE_DIR ?? '';
  const serialIndex = argv.indexOf('-s');
  const serial = serialIndex === -1 ? undefined : argv[serialIndex + 1];
  const rest = serialIndex === -1 ? [...argv] : [...argv.slice(0, serialIndex), ...argv.slice(serialIndex + 2)];
  const command = rest[0];
  const commandArgs = rest.slice(1);

  if (command === undefined) return { stderr: 'fake-adb: no arguments\n', code: 2 };
  if (command === '-list-avds') return { stdout: 'Pixel_4a\nPixel_6_API_34\n' };
  if (command === '-avd') return { stdout: '' };
  if (command === 'version') return { stdout: 'Android Debug Bridge version 1.0.41\nVersion 37.0.1-15733141\n' };
  if (command === 'start-server') return { stdout: '* daemon started successfully\n' };

  if (command === 'devices') {
    if (scenario === 'hang') return { hang: true };
    if (scenario === 'no-server') {
      const marker = path.join(stateDir, 'server-started.marker');
      if (!existsSync(marker)) {
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(marker, '1');
        return { stderr: "adb server version (41) doesn't match this client (39); cannot connect to daemon\n", code: 1 };
      }
      return { stdout: DEVICES.single };
    }
    return { stdout: DEVICES[/** @type {keyof typeof DEVICES} */ (scenario)] ?? DEVICES.single };
  }

  if (command === 'install') {
    if (scenario === 'install-fail') {
      return {
        stderr:
          'Performing Streamed Install\nadb: failed to install app.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Package com.example.app signatures do not match]\n',
        code: 1,
      };
    }
    if (scenario === 'install-timeout') return { hang: true };
    return { stdout: 'Performing Streamed Install\nSuccess\n' };
  }

  if (command === 'pull') {
    const remote = commandArgs[0];
    const target = commandArgs[1];
    if (!remote || !target) return { stderr: 'fake-adb: pull needs remote and local paths\n', code: 2 };
    if (remote.includes('missing')) {
      return { stderr: `adb: error: failed to stat remote object '${remote}': No such file or directory\n`, code: 1 };
    }
    writeFileSync(target, 'pulled-bytes');
    return { stdout: '1 file pulled, 0 skipped.\n' };
  }

  if (command === 'exec-out') {
    if (commandArgs[0] === 'screencap') return { stdout: PNG };
    return { stderr: 'fake-adb: unknown exec-out command\n', code: 2 };
  }

  if (command === 'logcat') return { stdout: `${LOGCAT_LINES.join('\n')}\n` };
  if (command === 'emu' && commandArgs[0] === 'kill') return { stdout: 'OK: killing emulator, bye bye\n' };

  if (command === 'shell') {
    const [tool, ...toolArgs] = commandArgs;
    if (tool === 'getprop') {
      const isEmulator = serial !== undefined && serial.startsWith('emulator-');
      return { stdout: isEmulator ? PROPS_EMULATOR : PROPS_PHONE };
    }
    if (tool === 'dumpsys' && toolArgs[0] === 'battery') {
      return { stdout: 'Current Battery Service state:\n  AC powered: false\n  level: 87\n  scale: 100\n' };
    }
    if (tool === 'dumpsys' && toolArgs[0] === 'power') {
      return { stdout: 'Power Manager State:\n  mWakefulness=Awake\n  mWakefulnessChanging=false\n' };
    }
    if (tool === 'dumpsys' && toolArgs[0] === 'package') {
      if (toolArgs[1] === 'com.example.app') {
        return {
          stdout:
            'Packages:\n' +
            '  Package [com.example.app] (abc123):\n' +
            '    userId=10123\n' +
            '    versionCode=42 minSdk=21 targetSdk=34\n' +
            '    versionName=1.2.3\n',
        };
      }
      return { stdout: `Unable to find package: ${toolArgs[1] ?? 'unknown'}\n` };
    }
    if (tool === 'cmd' && toolArgs[0] === 'package' && toolArgs[1] === 'resolve-activity') {
      const packageName = toolArgs[toolArgs.length - 1];
      if (packageName === 'com.missing') return { stderr: `No activity found while resolving ${packageName}\n`, code: 1 };
      return { stdout: 'priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\ncom.example.app/.MainActivity\n' };
    }
    if (tool === 'am' && toolArgs[0] === 'start') {
      const componentIndex = toolArgs.indexOf('-n');
      const component = componentIndex === -1 ? '' : toolArgs[componentIndex + 1];
      if (component.includes('Missing')) return { stderr: 'Error: Activity class does not exist.\n', code: 1 };
      return { stdout: `Starting: Intent { cmp=${component} }\n` };
    }
    if (tool === 'am' && toolArgs[0] === 'force-stop') return { stdout: '' };
    if (tool === 'pm' && toolArgs[0] === 'clear') {
      return { stdout: toolArgs[1] === 'com.missing' ? 'Failed\n' : 'Success\n' };
    }
    if (tool === 'pm' && toolArgs[0] === 'list') return { stdout: 'package:com.example.app\npackage:android\n' };
  }

  return { stderr: `fake-adb: unsupported command ${argv.join(' ')}\n`, code: 2 };
}
