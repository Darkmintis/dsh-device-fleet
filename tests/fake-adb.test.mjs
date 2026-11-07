import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TIMEOUTS } from '../lib/adb.js';
import { createFleetService } from '../lib/service.js';
import { createFakeSpawn } from './support/fake-process.mjs';

/** @type {typeof TIMEOUTS} */
const FAST_TIMEOUTS = {
  default: 2_000,
  install: 2_000,
  screenshot: 2_000,
  logcat: 2_000,
  pull: 2_000,
  shell: 2_000,
  server: 2_000,
  emulator: 2_000,
};

/**
 * Build a service wired to the scripted fake adb.
 *
 * @param {string} scenario Fake adb scenario name.
 * @param {Record<string, unknown>} [overrides] Service option overrides.
 * @returns {Promise<{ service: ReturnType<typeof createFleetService>, root: string, cleanup: () => Promise<void>, writeApk: (name?: string, magic?: string) => Promise<string> }>} test wiring.
 */
async function makeService(scenario, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-fleet-test-'));
  const stateDir = path.join(root, 'state');
  const tmpRoot = path.join(root, 'tmp');
  await mkdir(stateDir, { recursive: true });
  await mkdir(tmpRoot, { recursive: true });
  const service = createFleetService({
    adbPath: path.join(root, 'fake-adb'),
    spawn: /** @type {any} */ (createFakeSpawn()),
    env: { ...process.env, FAKE_ADB_SCENARIO: scenario, FAKE_ADB_STATE_DIR: stateDir },
    tmpRoot,
    timeouts: FAST_TIMEOUTS,
    ...overrides,
  });
  return {
    service,
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
    /**
     * @param {string} [name] File name.
     * @param {string} [magic] Leading bytes.
     * @returns {Promise<string>} APK path.
     */
    async writeApk(name = 'app-debug.apk', magic = 'PK\u0003\u0004') {
      const target = path.join(root, name);
      await writeFile(target, Buffer.concat([Buffer.from(magic, 'latin1'), Buffer.alloc(64)]));
      return target;
    },
  };
}

test('fleet_list enriches one phone without a device prompt', async (t) => {
  const { service, cleanup } = await makeService('single');
  t.after(cleanup);
  const result = await service.list({});
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.equal(result.total, 1);
  const device = result.devices[0];
  assert.equal(device.serial, 'R58M12345');
  assert.equal(device.model, 'SM_G973F');
  assert.equal(device.manufacturer, 'samsung');
  assert.equal(device.androidVersion, '13');
  assert.equal(device.sdk, 33);
  assert.equal(device.batteryPct, 87);
  assert.equal(device.screenOn, true);
  assert.equal(device.isEmulator, false);
  assert.match(String(result.adb.path), /fake-adb/u);
  assert.equal(result.adb.version, '1.0.41');
});

test('fleet_list reports an installed package version when asked', async (t) => {
  const { service, cleanup } = await makeService('single');
  t.after(cleanup);
  const result = await service.list({ packageName: 'com.example.app' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.devices[0].package, { name: 'com.example.app', versionName: '1.2.3', versionCode: '42' });

  const missing = await service.list({ packageName: 'com.missing' });
  assert.equal(missing.ok, true);
  assert.equal(missing.devices[0].package, undefined);
});

test('fleet_list handles multiple devices, emulators, and unauthorized rows', async (t) => {
  const { service, cleanup } = await makeService('mixed');
  t.after(cleanup);
  const result = await service.list({});
  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.equal(result.total, 3);
  assert.equal(result.devices[1].isEmulator, true);
  assert.equal(result.devices[1].androidVersion, '14');
  assert.equal(result.unauthorized.length, 1);
  assert.match(String(result.unauthorized[0].hint), /Allow USB debugging/u);
  assert.equal(result.offline.length, 0);
});

test('fleet_list is safe with zero connected devices', async (t) => {
  const { service, cleanup } = await makeService('none');
  t.after(cleanup);
  const result = await service.list({});
  assert.equal(result.ok, true);
  assert.equal(result.count, 0);
  assert.equal(result.total, 0);
  assert.deepEqual(result.devices, []);
});

test('action tools refuse to guess between multiple devices', async (t) => {
  const { service, cleanup } = await makeService('multi');
  t.after(cleanup);
  const result = await service.launch({ packageName: 'com.example.app' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SERIAL_REQUIRED');
  assert.equal(result.details.devices.length, 2);
  assert.match(String(result.hint), /serial/u);
});

test('action tools refuse offline and unauthorized devices with device-specific hints', async (t) => {
  const { service, cleanup } = await makeService('unauthorized');
  t.after(cleanup);
  const result = await service.launch({ packageName: 'com.example.app' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DEVICE_UNAUTHORIZED');
  assert.match(String(result.hint), /Allow USB debugging/u);

  const offlineService = await makeService('offline');
  t.after(offlineService.cleanup);
  const offline = await offlineService.service.launch({ packageName: 'com.example.app', serial: 'XYZ789' });
  assert.equal(offline.code, 'DEVICE_OFFLINE');
});

test('device_install validates APK paths and installs with a serial', async (t) => {
  const { service, cleanup, writeApk } = await makeService('multi');
  t.after(cleanup);
  const apk = await writeApk();
  const installed = await service.install({ serial: 'R58M12345', apkPath: apk });
  assert.equal(installed.ok, true);
  assert.equal(installed.serial, 'R58M12345');
  assert.match(String(installed.output), /Success/u);

  const missing = await service.install({ serial: 'R58M12345', apkPath: path.join(path.dirname(apk), 'nope.apk') });
  assert.equal(missing.code, 'APK_NOT_FOUND');

  const wrongExtension = await writeApk('app-debug.txt');
  assert.equal((await service.install({ serial: 'R58M12345', apkPath: wrongExtension })).code, 'APK_INVALID');

  const bogus = await writeApk('bogus.apk', 'nope');
  assert.equal((await service.install({ serial: 'R58M12345', apkPath: bogus })).code, 'APK_INVALID');
});

test('device_install maps adb install failures to hints', async (t) => {
  const { service, cleanup, writeApk } = await makeService('install-fail');
  t.after(cleanup);
  const apk = await writeApk();
  const result = await service.install({ serial: 'R58M12345', apkPath: apk });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INSTALL_FAILED');
  assert.match(String(result.error), /INSTALL_FAILED_UPDATE_INCOMPATIBLE/u);
  assert.match(String(result.hint), /signature/u);
});

test('device_install respects the install timeout', async (t) => {
  const { service, cleanup, writeApk } = await makeService('install-timeout', {
    timeouts: { ...FAST_TIMEOUTS, install: 300 },
  });
  t.after(cleanup);
  const apk = await writeApk();
  const result = await service.install({ serial: 'R58M12345', apkPath: apk });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ADB_TIMEOUT');
});

test('launch resolves the launcher component and reports missing packages', async (t) => {
  const { service, cleanup } = await makeService('single');
  t.after(cleanup);
  const launched = await service.launch({ packageName: 'com.example.app' });
  assert.equal(launched.ok, true);
  assert.equal(launched.component, 'com.example.app/.MainActivity');
  assert.match(String(launched.output), /Starting/u);

  const missing = await service.launch({ packageName: 'com.missing' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'PACKAGE_NOT_FOUND');
});

test('stop and clear-data report success and missing packages', async (t) => {
  const { service, cleanup } = await makeService('single');
  t.after(cleanup);
  assert.equal((await service.stop({ packageName: 'com.example.app' })).ok, true);
  const cleared = await service.clearData({ packageName: 'com.example.app' });
  assert.equal(cleared.ok, true);
  const missing = await service.clearData({ packageName: 'com.missing' });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, 'PACKAGE_NOT_FOUND');
});

test('deep links validate input and dispatch VIEW intents', async (t) => {
  const { service, cleanup } = await makeService('single');
  t.after(cleanup);
  const opened = await service.deepLink({ url: 'https://example.com/welcome?x=1' });
  assert.equal(opened.ok, true);
  assert.match(String(opened.output), /Starting/u);

  const invalid = await service.deepLink({ url: 'not a url' });
  assert.equal(invalid.code, 'INVALID_ARGUMENT');
  assert.equal((await service.deepLink({ url: 'javascript:alert(1)' })).code, 'INVALID_ARGUMENT');
});

test('device_shell enforces the allowlist and metacharacter policy end to end', async (t) => {
  const { service, cleanup } = await makeService('single');
  t.after(cleanup);
  const listed = await service.shell({ serial: 'R58M12345', command: 'pm list packages' });
  assert.equal(listed.ok, true);
  assert.match(String(listed.stdout), /package:com.example.app/u);

  const blocked = await service.shell({ serial: 'R58M12345', command: 'reboot' });
  assert.equal(blocked.code, 'SHELL_COMMAND_BLOCKED');

  const metachar = await service.shell({ serial: 'R58M12345', command: 'pm list packages; reboot' });
  assert.equal(metachar.code, 'SHELL_METACHARACTER');
});

test('device_screenshot saves a PNG in the plugin temp directory', async (t) => {
  const { service, root, cleanup } = await makeService('single');
  t.after(cleanup);
  const result = await service.screenshot({});
  assert.equal(result.ok, true);
  assert.equal(result.width, 1);
  assert.equal(result.height, 1);
  assert.equal(typeof result.bytes, 'number');
  assert.ok(String(result.path).startsWith(path.join(root, 'tmp', 'dsh-device-fleet', 'screenshots')));
  assert.equal((await stat(String(result.path))).size > 0, true);
});

test('screenshot cleanup removes stale PNGs only', async (t) => {
  const { service, root, cleanup } = await makeService('single');
  t.after(cleanup);
  const directory = path.join(root, 'tmp', 'dsh-device-fleet', 'screenshots');
  await mkdir(directory, { recursive: true });
  const stale = path.join(directory, 'stale.png');
  const fresh = path.join(directory, 'fresh.png');
  await writeFile(stale, 'old');
  await writeFile(fresh, 'new');
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await utimes(stale, old, old);
  const result = await service.screenshot({});
  assert.equal(result.cleaned, 1);
  await assert.rejects(stat(stale));
  assert.equal((await stat(fresh)).size, 3);
});

test('device_logcat presets and filters a bounded snapshot', async (t) => {
  const { service, cleanup } = await makeService('single');
  t.after(cleanup);
  const upload = await service.logcat({ preset: 'upload' });
  assert.equal(upload.ok, true);
  assert.equal(upload.preset, 'upload');
  assert.equal(upload.matched, 2);
  assert.ok(upload.lines.some((line) => String(line).includes('upload failed')));

  const filtered = await service.logcat({ preset: 'all', filter: '413' });
  assert.equal(filtered.matched, 1);
});

test('device_pull copies a device file into the plugin temp directory', async (t) => {
  const { service, root, cleanup } = await makeService('single');
  t.after(cleanup);
  const pulled = await service.pull({ remotePath: '/sdcard/Download/photo.jpg' });
  assert.equal(pulled.ok, true);
  assert.ok(String(pulled.path).startsWith(path.join(root, 'tmp', 'dsh-device-fleet', 'pulls')));
  assert.equal(pulled.bytes, 'pulled-bytes'.length);
  assert.equal((await service.pull({ remotePath: '../../etc/passwd' })).code, 'INVALID_ARGUMENT');
});

test('adb server restart retry succeeds once', async (t) => {
  const { service, cleanup } = await makeService('no-server');
  t.after(cleanup);
  const result = await service.list({});
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
});

test('missing adb produces an actionable ADB_NOT_FOUND failure', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-fleet-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = createFleetService({
    adbPath: path.join(root, 'does-not-exist', 'adb.exe'),
    env: { ...process.env },
    tmpRoot: root,
    timeouts: FAST_TIMEOUTS,
  });
  const result = await service.list({});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ADB_NOT_FOUND');
  assert.match(String(result.hint), /platform-tools/u);
  assert.match(String(result.hint), /ANDROID_HOME/u);
});

test('stalled adb commands hit the timeout instead of hanging', async (t) => {
  const { service, cleanup } = await makeService('hang', {
    timeouts: { ...FAST_TIMEOUTS, default: 400 },
  });
  t.after(cleanup);
  const result = await service.list({});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ADB_TIMEOUT');
});

test('device_which resolves the configured toolchain', async (t) => {
  const { service, cleanup } = await makeService('single');
  t.after(cleanup);
  const result = await service.which();
  assert.equal(result.ok, true);
  assert.equal(result.adb.found, true);
  assert.equal(result.platform, process.platform);
  assert.match(String(result.adb.path), /fake-adb/u);
});

test('emulator_start validates AVD names and boots through the emulator runner', async (t) => {
  const { service, root, cleanup } = await makeService('single', { emulatorPath: path.join(os.tmpdir(), 'fake-emulator') });
  t.after(cleanup);
  const unknown = await service.emulatorStart({ avdName: 'Does_Not_Exist' });
  assert.equal(unknown.code, 'EMULATOR_NOT_FOUND');
  assert.deepEqual(unknown.details.available, ['Pixel_4a', 'Pixel_6_API_34']);

  const started = await service.emulatorStart({ avdName: 'Pixel_4a' });
  assert.equal(started.ok, true);
  assert.equal(started.avdName, 'Pixel_4a');

  const injected = await service.emulatorStart({ avdName: 'Pixel_4a; reboot' });
  assert.equal(injected.code, 'INVALID_ARGUMENT');
  void root;
});

test('emulator_stop only accepts emulator serials', async (t) => {
  const { service, cleanup } = await makeService('multi');
  t.after(cleanup);
  const stopped = await service.emulatorStop({ serial: 'emulator-5554' });
  assert.equal(stopped.ok, true);
  const phone = await service.emulatorStop({ serial: 'R58M12345' });
  assert.equal(phone.code, 'EMULATOR_FAILED');
});
