/**
 * Runtime discovery of adb, the Android SDK, the emulator, java, and flutter.
 *
 * Nothing here is hard-coded to a machine: the Android SDK comes from
 * `ANDROID_HOME` / `ANDROID_SDK_ROOT` first, then well-known per-OS install
 * locations, then `PATH`. All checks are synchronous filesystem probes so tool
 * calls stay fast and deterministic.
 *
 * @module
 */

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** @typedef {{ path: string, source: string }} ToolLocation */

/**
 * Path helpers matching the discovery target rather than the host process.
 *
 * The SDK layout is a property of the target platform, so a Windows SDK probe
 * must use Windows separators even when the code runs (or is tested) on a POSIX
 * host. In production `platform` is the host platform, so both agree.
 *
 * @param {NodeJS.Platform} platform Target platform.
 * @returns {typeof path.win32} path implementation for that platform.
 */
function pathFor(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * @typedef {object} DiscoveryOptions
 * @property {NodeJS.ProcessEnv} [env] Environment to read.
 * @property {NodeJS.Platform} [platform] Target platform, defaulting to this process.
 * @property {string} [home] Home directory, defaulting to the current user's.
 * @property {(candidate: string) => boolean} [exists] Filesystem existence probe (test seam).
 */

/**
 * Drop empty entries from a PATH-style variable and normalise separators.
 *
 * @param {string | undefined} value Raw PATH value.
 * @param {NodeJS.Platform} platform Target platform.
 * @returns {string[]} Non-empty directory entries.
 */
export function splitPathList(value, platform) {
  if (typeof value !== 'string' || value === '') return [];
  const separator = platform === 'win32' ? ';' : ':';
  return value
    .split(separator)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter((entry) => entry !== '');
}

/**
 * Locate one executable on `PATH` by trying the platform-appropriate names.
 *
 * @param {string} command Base command name, for example `adb`.
 * @param {DiscoveryOptions} [options] Discovery options.
 * @returns {ToolLocation | undefined} Resolved executable and its discovery source.
 */
export function findOnPath(command, options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const p = pathFor(platform);
  const suffixes = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const directory of splitPathList(env.PATH ?? env.Path, platform)) {
    for (const suffix of suffixes) {
      const candidate = p.join(directory, command + suffix);
      if (exists(candidate)) return { path: p.resolve(candidate), source: 'PATH' };
    }
  }
  return undefined;
}

/**
 * Candidate Android SDK roots in discovery order.
 *
 * @param {DiscoveryOptions} [options] Discovery options.
 * @returns {Array<{ root: string, source: string }>} SDK roots with their discovery source.
 */
export function androidSdkRoots(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const p = pathFor(platform);
  /** @type {Array<{ root: string, source: string }>} */
  const roots = [];
  for (const key of ['ANDROID_HOME', 'ANDROID_SDK_ROOT']) {
    const value = env[key];
    if (typeof value === 'string' && value.trim() !== '') roots.push({ root: value.trim(), source: key });
  }
  if (platform === 'win32') {
    if (env.LOCALAPPDATA) roots.push({ root: p.join(env.LOCALAPPDATA, 'Android', 'Sdk'), source: 'LOCALAPPDATA' });
    if (env.USERPROFILE) roots.push({ root: p.join(env.USERPROFILE, 'AppData', 'Local', 'Android', 'Sdk'), source: 'USERPROFILE' });
    roots.push({ root: p.join(home, 'AppData', 'Local', 'Android', 'Sdk'), source: 'home' });
    roots.push({ root: 'C:\\Android\\Sdk', source: 'common path' });
    roots.push({ root: 'C:\\Program Files (x86)\\Android\\android-sdk', source: 'common path' });
  } else if (platform === 'darwin') {
    roots.push({ root: p.join(home, 'Library', 'Android', 'sdk'), source: 'home' });
  } else {
    roots.push({ root: p.join(home, 'Android', 'Sdk'), source: 'home' });
    roots.push({ root: '/usr/lib/android-sdk', source: 'common path' });
    roots.push({ root: '/opt/android-sdk', source: 'common path' });
    roots.push({ root: '/usr/local/lib/android/sdk', source: 'common path' });
  }
  const seen = new Set();
  return roots.filter((entry) => {
    const key = p.resolve(entry.root);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Resolve adb from an SDK root or `PATH`.
 *
 * @param {DiscoveryOptions} [options] Discovery options.
 * @returns {ToolLocation | undefined} adb executable and discovery source.
 */
export function resolveAdb(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const p = pathFor(platform);
  const executable = platform === 'win32' ? 'adb.exe' : 'adb';
  for (const entry of androidSdkRoots({ env, platform, home: options.home })) {
    const candidate = p.join(entry.root, 'platform-tools', executable);
    if (exists(candidate)) return { path: p.resolve(candidate), source: `${entry.source} ({root})`.replace('{root}', entry.root) };
  }
  return findOnPath('adb', { env, platform, exists });
}

/**
 * Resolve the Android emulator binary.
 *
 * @param {DiscoveryOptions} [options] Discovery options.
 * @returns {ToolLocation | undefined} emulator executable and discovery source.
 */
export function resolveEmulator(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const p = pathFor(platform);
  const executable = platform === 'win32' ? 'emulator.exe' : 'emulator';
  for (const entry of androidSdkRoots({ env, platform, home: options.home })) {
    const candidate = p.join(entry.root, 'emulator', executable);
    if (exists(candidate)) return { path: p.resolve(candidate), source: `${entry.source} ({root})`.replace('{root}', entry.root) };
  }
  return findOnPath('emulator', { env, platform, exists });
}

/**
 * Resolve java from `JAVA_HOME` then `PATH`.
 *
 * @param {DiscoveryOptions} [options] Discovery options.
 * @returns {ToolLocation | undefined} java executable and discovery source.
 */
export function resolveJava(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const p = pathFor(platform);
  const executable = platform === 'win32' ? 'java.exe' : 'java';
  const javaHome = env.JAVA_HOME;
  if (typeof javaHome === 'string' && javaHome.trim() !== '') {
    const candidate = p.join(javaHome.trim(), 'bin', executable);
    if (exists(candidate)) return { path: p.resolve(candidate), source: 'JAVA_HOME' };
  }
  return findOnPath('java', { env, platform, exists });
}

/**
 * Resolve the flutter command.
 *
 * @param {DiscoveryOptions} [options] Discovery options.
 * @returns {ToolLocation | undefined} flutter executable and discovery source.
 */
export function resolveFlutter(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const names = platform === 'win32' ? ['flutter.bat', 'flutter.cmd', 'flutter.exe'] : ['flutter'];
  for (const name of names) {
    const found = findOnPath(name, { env, platform, exists });
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Resolve the first existing Android SDK root.
 *
 * @param {DiscoveryOptions} [options] Discovery options.
 * @returns {{ root: string, source: string } | undefined} SDK root and discovery source.
 */
export function findAndroidSdk(options = {}) {
  const exists = options.exists ?? existsSync;
  const platform = options.platform ?? process.platform;
  const p = pathFor(platform);
  for (const entry of androidSdkRoots({ env: options.env, platform, home: options.home })) {
    const probe = p.join(entry.root, 'platform-tools');
    if (exists(entry.root) || exists(probe)) return entry;
  }
  return undefined;
}

/**
 * Locate the scrcpy binary (screen mirroring) for the panel's Mirror action.
 *
 * Order: explicit `SCRCPY` env override, `PATH`, then the WinGet package
 * directory, which the installer does not always add to PATH.
 *
 * @param {DiscoveryOptions} [options] Discovery options.
 * @returns {string | null} resolved executable path, or null when unavailable.
 */
export function resolveScrcpy(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const p = pathFor(platform);

  if (typeof env.SCRCPY === 'string' && env.SCRCPY.trim() !== '' && exists(env.SCRCPY.trim())) return p.resolve(env.SCRCPY.trim());

  const onPath = findOnPath('scrcpy', { env, platform, exists });
  if (onPath !== undefined) return onPath.path;

  if (platform === 'win32' && typeof env.LOCALAPPDATA === 'string') {
    const wingetRoot = p.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const entry of readdirSync(wingetRoot)) {
        if (!entry.startsWith('Genymobile.scrcpy')) continue;
        const packageRoot = p.join(wingetRoot, entry);
        for (const version of readdirSync(packageRoot)) {
          const candidate = p.join(packageRoot, version, 'scrcpy.exe');
          if (exists(candidate)) return candidate;
        }
      }
    } catch {
      // WinGet is optional; fall through to null.
    }
  }
  return null;
}
