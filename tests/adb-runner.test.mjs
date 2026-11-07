import assert from 'node:assert/strict';
import test from 'node:test';
import { TIMEOUTS, createAdbRunner, createEmulatorRunner, isMissingExecutable, needsServerStart } from '../lib/adb.js';
import { createFakeSpawn } from './support/fake-process.mjs';

/**
 * @param {any} spawn Spawn implementation.
 * @param {Partial<typeof TIMEOUTS>} [timeouts] Timeout overrides.
 * @returns {ReturnType<typeof createAdbRunner>} runner.
 */
function runner(spawn, timeouts = {}) {
  return createAdbRunner({
    adbPath: 'C:/fake/adb.exe',
    spawn,
    env: { FAKE_ADB_SCENARIO: 'single', FAKE_ADB_STATE_DIR: '' },
    timeouts: { ...TIMEOUTS, ...timeouts },
  });
}

test('run captures stdout, stderr, and exit code', async () => {
  const adb = runner(
    createFakeSpawn(() => ({ stdout: 'out', stderr: 'err', code: 0 })),
  );
  const result = await adb.run(['devices']);
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'out');
  assert.equal(result.stderr, 'err');
  assert.equal(result.code, 0);
});

test('run injects the -s serial selector', async () => {
  /** @type {string[]} */
  let seen = [];
  const adb = runner(
    createFakeSpawn((args) => {
      seen = [...args];
      return { stdout: 'ok' };
    }),
  );
  await adb.run(['shell', 'getprop'], { serial: 'emulator-5554' });
  assert.deepEqual(seen, ['-s', 'emulator-5554', 'shell', 'getprop']);
});

test('run kills a hanging process and reports the timeout', async () => {
  const adb = runner(createFakeSpawn(() => ({ hang: true })), { default: 50 });
  const started = Date.now();
  const result = await adb.run(['devices']);
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 2_000);
});

test('run reports a missing executable as a spawn failure', async () => {
  const adb = runner(() => {
    const error = /** @type {Error & { code: string }} */ (new Error('spawn ENOENT'));
    error.code = 'ENOENT';
    throw error;
  });
  const result = await adb.run(['version']);
  assert.equal(result.ok, false);
  assert.equal(result.spawnError, 'ENOENT');
  assert.equal(isMissingExecutable(result), true);
});

test('listDevices parses a healthy server without restarting it', async () => {
  const adb = runner(createFakeSpawn());
  const listing = await adb.listDevices();
  assert.equal(listing.ok, true);
  if (listing.ok !== true) return;
  assert.equal(listing.devices.length, 1);
  assert.equal(listing.devices[0].serial, 'R58M12345');
  assert.equal(listing.serverStarted, false);
});

test('listDevices surfaces a spawn failure without a result', async () => {
  const adb = runner(() => {
    const error = /** @type {Error & { code: string }} */ (new Error('denied'));
    error.code = 'EPERM';
    throw error;
  });
  const listing = await adb.listDevices();
  assert.equal(listing.ok, false);
  if (listing.ok === false) assert.equal(listing.result, undefined);
});

test('needsServerStart recognises daemon failures', () => {
  assert.equal(
    needsServerStart({ ok: false, code: 1, stdout: '', stderr: 'cannot connect to daemon', timedOut: false }),
    true,
  );
  assert.equal(
    needsServerStart({ ok: false, code: 1, stdout: '', stderr: 'error: more than one device/emulator', timedOut: false }),
    false,
  );
});

test('version parses the ADB version', async () => {
  const adb = runner(createFakeSpawn());
  assert.deepEqual(await adb.version(), { ok: true, version: '1.0.41' });
});

test('emulator runner lists AVDs and resolves a detached start', async () => {
  const emulator = createEmulatorRunner({
    emulatorPath: 'C:/fake/emulator.exe',
    spawn: createFakeSpawn(),
    env: { FAKE_ADB_SCENARIO: 'single' },
  });
  const avds = await emulator.listAvds();
  assert.deepEqual(avds, { ok: true, avds: ['Pixel_4a', 'Pixel_6_API_34'] });
  const started = await emulator.start('Pixel_4a');
  assert.equal(started.ok, true);
  if (started.ok) assert.equal(started.pid, 4242);
});
