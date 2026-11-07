import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SCREENSHOT_TTL_MS, captureScreenshot, cleanupScreenshots, screenshotDirectory } from '../lib/screenshot.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * @param {{ ok?: boolean, timedOut?: boolean, stdout?: Buffer | string, stderr?: string }} result Run result override.
 * @returns {any} stub adb runner.
 */
function stubAdb(result) {
  return {
    adbPath: 'C:/fake/adb.exe',
    timeouts: { screenshot: 15_000 },
    run: async () => ({ ok: true, code: 0, timedOut: false, stdout: PNG, stderr: '', ...result }),
  };
}

test('screenshotDirectory is plugin-owned and under the temp root', () => {
  assert.equal(screenshotDirectory('/tmp/x'), path.join('/tmp/x', 'dsh-device-fleet', 'screenshots'));
});

test('cleanupScreenshots removes only stale PNGs', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-shot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  const stale = path.join(root, 'stale.png');
  const fresh = path.join(root, 'fresh.png');
  const text = path.join(root, 'notes.txt');
  await writeFile(stale, 'old');
  await writeFile(fresh, 'new');
  await writeFile(text, 'keep');
  const old = new Date(Date.now() - SCREENSHOT_TTL_MS - 60_000);
  await utimes(stale, old, old);
  const removed = await cleanupScreenshots(root);
  assert.equal(removed, 1);
  await assert.rejects(stat(stale));
  assert.equal((await stat(fresh)).size, 3);
  assert.equal((await stat(text)).size, 4);
});

test('captureScreenshot writes a PNG and reports its dimensions', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-shot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await captureScreenshot({ adb: stubAdb({}), serial: 'emulator-5554', tmpRoot: root });
  assert.equal(result.ok, true);
  assert.equal(result.width, 1);
  assert.equal(result.height, 1);
  assert.equal(result.serial, 'emulator-5554');
  const info = await stat(String(result.path));
  assert.ok(info.size > 0);
  assert.ok(String(result.path).includes('screenshots'));
});

test('captureScreenshot maps timeouts and non-PNG output to failures', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-shot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const timeout = await captureScreenshot({ adb: stubAdb({ ok: false, timedOut: true }), serial: 'X', tmpRoot: root });
  assert.equal(timeout.code, 'ADB_TIMEOUT');
  const corrupt = await captureScreenshot({ adb: stubAdb({ stdout: Buffer.from('garbage') }), serial: 'X', tmpRoot: root });
  assert.equal(corrupt.code, 'SCREENSHOT_FAILED');
  assert.match(String(corrupt.hint), /unlock/iu);
});
