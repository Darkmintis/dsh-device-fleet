import assert from 'node:assert/strict';
import test from 'node:test';
import { androidSdkRoots, findAndroidSdk, findOnPath, resolveAdb, resolveFlutter, resolveJava, resolveScrcpy, splitPathList } from '../lib/platform.js';

/** @param {Set<string>} existing */
function existsIn(existing) {
  return (candidate) => existing.has(candidate.replaceAll('\\', '/'));
}

/**
 * Normalise separators so Windows-shaped expectations hold on any CI OS:
 * the discovery module runs on the host platform, so `node:path` joins with
 * backslashes on Windows and forward slashes on Linux/macOS.
 *
 * @param {string | undefined} value Resolved path.
 * @returns {string} slash-normalised path.
 */
function slash(value) {
  return (value ?? '').replaceAll('\\', '/');
}

const WIN = /** @type {NodeJS.Platform} */ ('win32');

test('splitPathList splits on the platform separator and drops blanks', () => {
  assert.deepEqual(splitPathList('C:/one;;C:/two;', WIN), ['C:/one', 'C:/two']);
  assert.deepEqual(splitPathList('/bin::/usr/bin:', 'linux'), ['/bin', '/usr/bin']);
  assert.deepEqual(splitPathList(undefined, 'linux'), []);
});

test('findOnPath probes platform suffixes in PATH order', () => {
  const env = { PATH: 'C:/tools;C:/android/platform-tools' };
  const existing = new Set(['C:/android/platform-tools/adb.exe']);
  const found = findOnPath('adb', { env, platform: WIN, exists: existsIn(existing) });
  assert.equal(slash(found?.path), 'C:/android/platform-tools/adb.exe');
  assert.equal(found?.source, 'PATH');
});

test('resolveAdb prefers ANDROID_HOME over PATH', () => {
  const env = { ANDROID_HOME: 'D:/sdk', PATH: 'C:/tools' };
  const existing = new Set(['D:/sdk/platform-tools/adb.exe', 'C:/tools/adb.exe']);
  const found = resolveAdb({ env, platform: WIN, exists: existsIn(existing) });
  assert.equal(slash(found?.path), 'D:/sdk/platform-tools/adb.exe');
  assert.match(found?.source ?? '', /ANDROID_HOME/u);
});

test('resolveAdb falls back to ANDROID_SDK_ROOT then PATH then undefined', () => {
  const env = { ANDROID_SDK_ROOT: 'E:/android', PATH: 'C:/tools' };
  const rooted = new Set(['E:/android/platform-tools/adb.exe']);
  assert.equal(slash(resolveAdb({ env, platform: WIN, exists: existsIn(rooted) })?.path), 'E:/android/platform-tools/adb.exe');

  const pathOnly = new Set(['C:/tools/adb.exe']);
  assert.equal(slash(resolveAdb({ env, platform: WIN, exists: existsIn(pathOnly) })?.path), 'C:/tools/adb.exe');

  assert.equal(resolveAdb({ env: {}, platform: WIN, exists: () => false }), undefined);
});

test('androidSdkRoots de-duplicates and keeps env roots first', () => {
  const roots = androidSdkRoots({ env: { ANDROID_HOME: 'C:/sdk', ANDROID_SDK_ROOT: 'C:/sdk' }, platform: WIN, home: 'C:/Users/me' });
  assert.equal(roots[0].source, 'ANDROID_HOME');
  const values = roots.map((entry) => entry.root.replaceAll('\\', '/').toLowerCase());
  assert.equal(new Set(values).size, values.length);
});

test('findAndroidSdk reports the first existing root', () => {
  const env = { ANDROID_HOME: 'C:/sdk' };
  const sdk = findAndroidSdk({ env, platform: WIN, home: 'C:/Users/me', exists: existsIn(new Set(['C:/sdk', 'C:/Users/me/AppData/Local/Android/Sdk'])) });
  assert.equal(sdk?.root, 'C:/sdk');
  assert.equal(findAndroidSdk({ env: {}, platform: WIN, home: 'C:/Users/me', exists: () => false }), undefined);
});

test('resolveJava uses JAVA_HOME before PATH', () => {
  const env = { JAVA_HOME: 'D:/jdk-21', PATH: 'C:/tools' };
  const existing = new Set(['D:/jdk-21/bin/java.exe', 'C:/tools/java.exe']);
  const found = resolveJava({ env, platform: WIN, exists: existsIn(existing) });
  assert.equal(slash(found?.path), 'D:/jdk-21/bin/java.exe');
  assert.equal(found?.source, 'JAVA_HOME');
});

test('resolveFlutter finds the Windows batch wrapper', () => {
  const env = { PATH: 'D:/dev/flutter/bin' };
  const found = resolveFlutter({ env, platform: WIN, exists: existsIn(new Set(['D:/dev/flutter/bin/flutter.bat'])) });
  assert.equal(slash(found?.path), 'D:/dev/flutter/bin/flutter.bat');
});

test('resolveScrcpy prefers the SCRCPY override, then PATH, then nothing', () => {
  const env = { SCRCPY: 'C:/tools/scrcpy.exe', PATH: 'C:/extra' };
  const existing = new Set(['C:/tools/scrcpy.exe', 'C:/extra/scrcpy.exe']);
  assert.equal(slash(resolveScrcpy({ env, platform: WIN, exists: existsIn(existing) })), 'C:/tools/scrcpy.exe');

  const pathOnly = resolveScrcpy({ env: { PATH: 'C:/extra' }, platform: WIN, exists: existsIn(new Set(['C:/extra/scrcpy.exe'])) });
  assert.equal(slash(pathOnly), 'C:/extra/scrcpy.exe');

  assert.equal(resolveScrcpy({ env: {}, platform: WIN, exists: () => false }), null);
});
