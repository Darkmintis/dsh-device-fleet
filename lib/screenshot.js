/**
 * PNG screenshot capture into a plugin-owned temp directory.
 *
 * Screenshots live under `<tmp>/dsh-device-fleet/screenshots` and are pruned
 * when older than 24 hours on every capture, so repeated acceptance runs do not
 * leave unbounded files behind.
 *
 * @module
 */

import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parsePngSize, serialForFilename } from './parse.js';
import { ErrorCodes, failure, success } from './errors.js';

/** Screenshots older than this are removed on the next capture. */
export const SCREENSHOT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Directory holding screenshots for this plugin.
 *
 * @param {string} [tmpRoot] Temp root, defaulting to the OS temp directory.
 * @returns {string} Absolute screenshot directory.
 */
export function screenshotDirectory(tmpRoot = os.tmpdir()) {
  return path.join(tmpRoot, 'dsh-device-fleet', 'screenshots');
}

/**
 * Remove stale screenshot files, best effort.
 *
 * @param {string} directory Screenshot directory.
 * @param {{ now?: number, ttlMs?: number }} [options] Clock and TTL overrides (test seam).
 * @returns {Promise<number>} Number of files removed.
 */
export async function cleanupScreenshots(directory, options = {}) {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? SCREENSHOT_TTL_MS;
  let removed = 0;
  /** @type {string[]} */
  let entries;
  try {
    entries = await readdir(directory);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.png')) continue;
    const target = path.join(directory, entry);
    try {
      const info = await stat(target);
      if (now - info.mtimeMs > ttlMs) {
        await unlink(target);
        removed += 1;
      }
    } catch {
      // A concurrent cleanup or a vanished file is fine; keep going.
    }
  }
  return removed;
}

/**
 * Capture one device screenshot.
 *
 * @param {object} options Capture options.
 * @param {ReturnType<typeof import('./adb.js').createAdbRunner>} options.adb Resolved adb runner.
 * @param {string} options.serial Target device serial.
 * @param {string} [options.tmpRoot] Temp root override.
 * @param {number} [options.now] Epoch milliseconds override (test seam).
 * @param {number} [options.ttlMs] Screenshot TTL override.
 * @returns {Promise<Record<string, unknown>>} success payload or failure envelope.
 */
export async function captureScreenshot(options) {
  const { adb, serial } = options;
  const result = await adb.run(['exec-out', 'screencap', '-p'], {
    serial,
    timeoutMs: adb.timeouts.screenshot,
    binary: true,
  });
  if (!result.ok) {
    if (result.timedOut) {
      return failure(
        ErrorCodes.ADB_TIMEOUT,
        `screencap on ${serial} timed out after ${adb.timeouts.screenshot} ms`,
        'Unlock the device and retry; a sleeping device can hang screencap.',
        { serial },
      );
    }
    return failure(
      ErrorCodes.SCREENSHOT_FAILED,
      `screencap on ${serial} failed`,
      'Check that the device is unlocked and responsive, then retry.',
      { serial, stderr: String(result.stderr).slice(0, 500) },
    );
  }
  const bytes = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(String(result.stdout), 'utf8');
  const size = parsePngSize(bytes);
  if (size === undefined) {
    return failure(
      ErrorCodes.SCREENSHOT_FAILED,
      `screencap on ${serial} did not return a PNG image`,
      'The device may be showing a secure (FLAG_SECURE) screen; unlock it and retry.',
      { serial, bytes: bytes.length },
    );
  }
  const now = options.now ?? Date.now();
  const directory = screenshotDirectory(options.tmpRoot);
  await mkdir(directory, { recursive: true });
  const cleaned = await cleanupScreenshots(directory, { now, ttlMs: options.ttlMs });
  const stamp = new Date(now).toISOString().replace(/[:.]/gu, '-');
  const target = path.join(directory, `${stamp}-${serialForFilename(serial)}.png`);
  await writeFile(target, bytes);
  return success('device_screenshot', {
    serial,
    path: target,
    bytes: bytes.length,
    width: size.width,
    height: size.height,
    cleaned,
  });
}
