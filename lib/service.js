/**
 * Device fleet operations: the testable middle layer between adb and the tools.
 *
 * Every public method resolves with the standard success/failure envelope and
 * never rejects. Device discovery, serial disambiguation, path validation, and
 * timeout mapping live here; `lib/tools.js` only validates arguments and
 * formats results.
 *
 * @module
 */

import { existsSync } from 'node:fs';
import { mkdir, open, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAdbRunner, createEmulatorRunner, isMissingExecutable, spawnDetached as launchDetached } from './adb.js';
import {
  findAndroidSdk,
  resolveAdb,
  resolveEmulator,
  resolveFlutter,
  resolveJava,
  resolveScrcpy,
} from './platform.js';
import {
  clearSucceeded,
  installSucceeded,
  isEmulator,
  isReady,
  parseBatteryLevel,
  parsePackageVersion,
  parseProps,
  parseResolvedComponent,
  parseScreenAwake,
} from './parse.js';
import { validateShellCommand } from './shell-policy.js';
import { captureScreenshot } from './screenshot.js';
import { FETCH_LINE_CAP, LOGCAT_PRESETS, selectLogcatLines, splitLogLines } from './logcat.js';
import { ErrorCodes, failure, success } from './errors.js';

/** Tools that mutate device or app state and therefore require approval. */
export const DESTRUCTIVE_TOOLS = Object.freeze(['device_install', 'device_clear_data']);

/** Temporary directory owned by the plugin (screenshots, pulls). */
export const PLUGIN_TEMP_DIR = 'dsh-device-fleet';

/** Discovery results are reused for this long so repeated calls stay cheap. */
const DISCOVERY_TTL_MS = 30_000;

/** adb version is queried at most once per minute. */
const VERSION_TTL_MS = 60_000;

/**
 * @typedef {object} FleetServiceOptions
 * @property {NodeJS.ProcessEnv} [env] Environment for discovery and child processes.
 * @property {NodeJS.Platform} [platform] Target platform.
 * @property {typeof import('node:child_process').spawn} [spawn] Spawn implementation (test seam).
 * @property {(candidate: string) => boolean} [exists] Existence probe (test seam).
 * @property {() => number} [now] Clock (test seam).
 * @property {string} [tmpRoot] Temp root (test seam).
 * @property {string} [home] Home directory (test seam).
 * @property {string} [adbPath] Explicit adb path (test seam).
 * @property {string} [emulatorPath] Explicit emulator path (test seam).
 * @property {string | null} [scrcpyPath] Explicit scrcpy path (test seam).
 * @property {typeof import('./adb.js').spawnDetached} [spawnDetached] Detached launcher (test seam).
 * @property {typeof import('./adb.js').TIMEOUTS} [timeouts] Timeout table override (test seam).
 */

/**
 * @typedef {object} ResolvedAdb
 * @property {true} ok Resolved successfully.
 * @property {ReturnType<typeof createAdbRunner>} adb adb runner.
 * @property {string} path adb executable path.
 * @property {string} source Discovery source.
 * @property {string} [version] adb version string.
 */

/**
 * Create the fleet service.
 *
 * @param {FleetServiceOptions} [options] Service options.
 * @returns {ReturnType<typeof buildService>} fleet service.
 */
export function createFleetService(options = {}) {
  return buildService(options);
}

/**
 * @param {FleetServiceOptions} options Service options.
 */
function buildService(options) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const spawn = options.spawn;
  const spawnDetached = options.spawnDetached ?? launchDetached;
  const scrcpyPath = options.scrcpyPath;
  const exists = options.exists ?? existsSync;
  const now = options.now ?? Date.now;
  const tmpRoot = options.tmpRoot ?? os.tmpdir();
  const home = options.home ?? os.homedir();
  const timeouts = options.timeouts;

  /** @type {{ at: number, location: { path: string, source: string } | undefined } | undefined} */
  let discoveryCache;
  /** @type {{ at: number, version: { version?: string } } | undefined} */
  let versionCache;
  /** @type {{ path: string, runner: ReturnType<typeof createAdbRunner> } | undefined} */
  let runnerCache;

  /**
   * Cached adb runner for the configured/discovered binary.
   * @returns {ReturnType<typeof createAdbRunner> | undefined} runner.
   */
  function adbRunner() {
    const location = discover();
    if (location === undefined) return undefined;
    if (runnerCache !== undefined && runnerCache.path === location.path) return runnerCache.runner;
    const runner = createAdbRunner({
      adbPath: location.path,
      ...(spawn === undefined ? {} : { spawn }),
      ...(timeouts === undefined ? {} : { timeouts }),
      env,
      platform,
    });
    runnerCache = { path: location.path, runner };
    return runner;
  }

  /**
   * Discover adb, memoised for a short window.
   *
   * @returns {{ path: string, source: string } | undefined} adb location.
   */
  function discover() {
    const at = now();
    if (discoveryCache !== undefined && at - discoveryCache.at < DISCOVERY_TTL_MS) return discoveryCache.location;
    const location = options.adbPath !== undefined ? { path: options.adbPath, source: 'configured' } : resolveAdb({ env, platform, home, exists });
    discoveryCache = { at, location };
    return location;
  }

  /**
   * Resolve adb and confirm the executable can actually be spawned.
   *
   * @returns {Promise<ResolvedAdb | ReturnType<typeof failure>>} resolved adb or a failure envelope.
   */
  async function adbContext() {
    const location = discover();
    if (location === undefined) {
      return missingAdbFailure();
    }
    if (runnerCache === undefined || runnerCache.path !== location.path) {
      try {
        const runner = createAdbRunner({
          adbPath: location.path,
          ...(spawn === undefined ? {} : { spawn }),
          ...(timeouts === undefined ? {} : { timeouts }),
          env,
          platform,
        });
        runnerCache = { path: location.path, runner };
        versionCache = undefined;
      } catch (error) {
        return failure(
          ErrorCodes.ADB_NOT_FOUND,
          `adb was found at ${location.path} but could not be started: ${error instanceof Error ? error.message : String(error)}`,
          'Reinstall Android platform-tools or point ANDROID_HOME at a working Android SDK.',
          { adbPath: location.path },
        );
      }
    }
    const runner = runnerCache.runner;
    const at = now();
    if (versionCache === undefined || at - versionCache.at > VERSION_TTL_MS) {
      const probe = await runner.run(['version'], { timeoutMs: 5_000 });
      if (isMissingExecutable(probe)) return missingAdbFailure(location.path);
      const version = runnerVersion(probe);
      versionCache = { at, version };
    }
    return {
      ok: true,
      adb: runner,
      path: location.path,
      source: location.source,
      ...(versionCache.version.version === undefined ? {} : { version: versionCache.version.version }),
    };
  }

  /**
   * Resolve one target device, enforcing the no-guess rule for multiple devices.
   *
   * @param {string} tool Wire tool name for error text.
   * @param {string | undefined} serial Explicit serial.
   * @param {{ requireSerial?: boolean, requireEmulator?: boolean }} [requirements] Selection requirements.
   * @returns {Promise<{ ok: true, adb: ReturnType<typeof createAdbRunner>, adbPath: string, device: import('./parse.js').AdbDevice, devices: import('./parse.js').AdbDevice[] } | ReturnType<typeof failure>>} selected device.
   */
  async function selectDevice(tool, serial, requirements = {}) {
    const context = await adbContext();
    if (context.ok !== true) return context;
    const listing = await context.adb.listDevices();
    if (listing.ok !== true) {
      return adbCommandFailure(tool, listing.result, 'Check that USB debugging is enabled and the adb server can start.');
    }
    const devices = listing.devices;
    if (devices.length === 0) {
      return failure(
        ErrorCodes.NO_DEVICES,
        'No Android devices or emulators are connected.',
        'Connect a phone over USB with USB debugging enabled, or boot an emulator, then retry fleet_list.',
        { adbPath: context.path },
      );
    }
    /** @type {import('./parse.js').AdbDevice | undefined} */
    let device;
    if (serial !== undefined) {
      device = devices.find((candidate) => candidate.serial === serial);
      if (device === undefined) {
        return failure(
          ErrorCodes.SERIAL_NOT_FOUND,
          `No connected device has serial "${serial}".`,
          'Call fleet_list to see the exact serials of connected devices.',
          { requested: serial, available: devices.map(deviceSummary) },
        );
      }
    } else if (requirements.requireSerial === true) {
      return failure(
        ErrorCodes.SERIAL_REQUIRED,
        `${tool} requires an explicit serial because more than one device may be connected.`,
        'Call fleet_list first, then pass serial=<one of the returned serials>.',
        { available: devices.map(deviceSummary) },
      );
    } else {
      const ready = devices.filter(isReady);
      if (ready.length === 0) return noReadyDevicesFailure(tool, devices);
      if (ready.length > 1) {
        return failure(
          ErrorCodes.SERIAL_REQUIRED,
          `${ready.length} devices are connected; pass serial to choose one. This tool never guesses.`,
          'Call fleet_list for serials, then retry with serial=<value> for each device.',
          { devices: ready.map(deviceSummary) },
        );
      }
      device = ready[0];
    }
    if (!isReady(device)) return notReadyFailure(tool, device);
    if (requirements.requireEmulator === true && !device.serial.startsWith('emulator-') && !isEmulator(device)) {
      return failure(
        ErrorCodes.EMULATOR_FAILED,
        `${device.serial} is not an Android emulator.`,
        'emulator_stop only works on emulator-<port> serials.',
        { device: deviceSummary(device) },
      );
    }
    return { ok: true, adb: context.adb, adbPath: context.path, device, devices };
  }

  /**
   * Enrich one ready device with props, battery, screen, and optional package version.
   *
   * @param {ReturnType<typeof createAdbRunner>} adb adb runner.
   * @param {import('./parse.js').AdbDevice} device Parsed device.
   * @param {string | undefined} packageName Optional package to inspect.
   * @returns {Promise<Record<string, unknown>>} enriched device row.
   */
  async function enrichDevice(adb, device, packageName) {
    const timeoutMs = adb.timeouts.default;
    /** @type {Record<string, string>} */
    let props = {};
    const [propsResult, batteryResult, powerResult] = await Promise.all([
      adb.run(['shell', 'getprop'], { serial: device.serial, timeoutMs }),
      adb.run(['shell', 'dumpsys', 'battery'], { serial: device.serial, timeoutMs }),
      adb.run(['shell', 'dumpsys', 'power'], { serial: device.serial, timeoutMs }),
    ]);
    if (propsResult.ok) props = parseProps(String(propsResult.stdout));
    const batteryPct = batteryResult.ok ? parseBatteryLevel(String(batteryResult.stdout)) : undefined;
    const screenOn = powerResult.ok ? parseScreenAwake(String(powerResult.stdout)) : undefined;
    /** @type {{ name: string, versionName?: string, versionCode?: string } | undefined} */
    let pkg;
    if (packageName !== undefined) {
      const pkgResult = await adb.run(['shell', 'dumpsys', 'package', packageName], { serial: device.serial, timeoutMs });
      const version = pkgResult.ok ? parsePackageVersion(String(pkgResult.stdout), packageName) : undefined;
      if (version !== undefined) pkg = { name: packageName, ...version };
    }
    /** @type {Record<string, unknown>} */
    const row = {
      serial: device.serial,
      state: device.state,
      model: props['ro.product.model'] ?? device.model ?? 'unknown',
      manufacturer: props['ro.product.manufacturer'],
      device: props['ro.product.device'] ?? device.device,
      androidVersion: props['ro.build.version.release'],
      sdk: toInteger(props['ro.build.version.sdk']),
      batteryPct,
      screenOn,
      isEmulator: isEmulator(device, props),
      adbPath: adb.adbPath,
    };
    if (pkg !== undefined) row.package = pkg;
    return row;
  }

  // ------------------------------------------------------------------------
  // Tool operations
  // ------------------------------------------------------------------------

  return {
    /** Wire names that require approval. */
    destructiveTools: DESTRUCTIVE_TOOLS,

    /**
     * `fleet_list`: enumerate devices with state, versions, battery, screen, and optional package version.
     *
     * @param {{ serial?: string, packageName?: string }} args Validated arguments.
     * @returns {Promise<Record<string, unknown>>} result envelope.
     */
    async list(args) {
      const context = await adbContext();
      if (context.ok !== true) return context;
      const listing = await context.adb.listDevices();
      if (listing.ok !== true) {
        return adbCommandFailure('fleet_list', listing.result, 'Enable USB debugging, accept the RSA prompt, then retry.');
      }
      let devices = listing.devices;
      if (args.serial !== undefined) {
        devices = devices.filter((device) => device.serial === args.serial);
        if (devices.length === 0) {
          return failure(ErrorCodes.SERIAL_NOT_FOUND, `No connected device has serial "${args.serial}".`, 'Call fleet_list without serial to see connected serials.', {
            requested: args.serial,
          });
        }
      }
      const ready = devices.filter(isReady);
      const rows = await Promise.all(
        ready.map(async (device) => {
          try {
            return await enrichDevice(context.adb, device, args.packageName);
          } catch (error) {
            return { ...deviceSummary(device), probeError: error instanceof Error ? error.message : String(error) };
          }
        }),
      );
      const unauthorized = devices
        .filter((device) => device.state === 'unauthorized')
        .map((device) => ({
          serial: device.serial,
          model: device.model ?? 'unknown device',
          hint: `Tap "Allow USB debugging" on ${device.model ?? device.serial}, then retry fleet_list.`,
        }));
      const offline = devices.filter((device) => device.state === 'offline').map(deviceSummary);
      const sdk = findAndroidSdk({ env, platform, home, exists });
      /** @type {Record<string, unknown>} */
      const payload = {
        adb: { path: context.path, source: context.source, version: context.version },
        count: ready.length,
        total: devices.length,
        devices: rows,
        unauthorized,
        offline,
        warnings: listing.warnings,
      };
      if (sdk !== undefined) payload.androidSdk = sdk.root;
      return success('fleet_list', payload);
    },

    /**
     * `device_install`: install or replace an APK.
     *
     * @param {{ serial?: string, apkPath: string }} args Validated arguments.
     * @returns {Promise<Record<string, unknown>>} result envelope.
     */
    async install(args) {
      const apk = await validateApk(args.apkPath);
      if (apk.ok !== true) return apk;
      const target = await selectDevice('device_install', args.serial);
      if (target.ok !== true) return target;
      const started = now();
      const result = await target.adb.run(['install', '-r', apk.path], {
        serial: target.device.serial,
        timeoutMs: target.adb.timeouts.install,
      });
      const output = combinedOutput(result);
      if (result.timedOut) {
        return failure(
          ErrorCodes.ADB_TIMEOUT,
          `adb install on ${target.device.serial} timed out after ${target.adb.timeouts.install} ms`,
          'Large APKs can need longer. Retry once; if it repeats, install manually with adb install -r.',
          { serial: target.device.serial, apkPath: apk.path },
        );
      }
      if (isMissingExecutable(result)) return missingAdbFailure(target.adb.adbPath);
      if (!installSucceeded(output)) {
        return failure(
          ErrorCodes.INSTALL_FAILED,
          `adb install on ${target.device.serial} failed: ${installFailureLine(output)}`,
          installHint(output),
          { serial: target.device.serial, apkPath: apk.path, output: limit(output, 2_000) },
        );
      }
      return success('device_install', {
        serial: target.device.serial,
        ...(target.device.model === undefined ? {} : { model: target.device.model }),
        apkPath: apk.path,
        apkBytes: apk.bytes,
        durationMs: now() - started,
        output: limit(output.trim(), 2_000),
      });
    },

    /**
     * `device_launch`: start a package's launcher activity with `am start`.
     *
     * @param {{ serial?: string, packageName: string }} args Validated arguments.
     * @returns {Promise<Record<string, unknown>>} result envelope.
     */
    async launch(args) {
      const target = await selectDevice('device_launch', args.serial);
      if (target.ok !== true) return target;
      const { adb, device } = target;
      const resolved = await adb.run(
        ['shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', args.packageName],
        { serial: device.serial, timeoutMs: adb.timeouts.default },
      );
      if (resolved.timedOut) return adbCommandFailure('device_launch', resolved, 'The device may be busy; retry.');
      const component = parseResolvedComponent(String(resolved.stdout ?? ''));
      if (component === undefined) {
        return failure(
          ErrorCodes.PACKAGE_NOT_FOUND,
          `No launcher activity found for "${args.packageName}" on ${device.serial}.`,
          'Check the package name with fleet_list (pass packageName), or install the APK with device_install. Services and libraries have no launcher activity.',
          { serial: device.serial, packageName: args.packageName },
        );
      }
      const started = await adb.run(['shell', 'am', 'start', '-n', component], { serial: device.serial, timeoutMs: adb.timeouts.default });
      const output = combinedOutput(started);
      if (started.timedOut) return adbCommandFailure('device_launch', started, 'am start hung; retry once.');
      if (/^Error|exception|not found/imu.test(output)) {
        return failure(
          ErrorCodes.PACKAGE_NOT_FOUND,
          `am start failed for ${args.packageName} on ${device.serial}: ${firstMeaningfulLine(output)}`,
          'Verify the package is installed and has a launcher activity.',
          { serial: device.serial, packageName: args.packageName, component, output: limit(output, 1_500) },
        );
      }
      return success('device_launch', {
        serial: device.serial,
        packageName: args.packageName,
        component,
        output: limit(output.trim(), 1_500),
      });
    },

    /**
     * `foreground`: the package of the app currently in front on a device.
     * Read-only: it inspects `dumpsys activity activities` for the resumed
     * activity so the panel can relaunch the app without asking for a package.
     *
     * @param {{ serial?: string }} args Validated arguments.
     * @returns {Promise<Record<string, unknown>>} result envelope with `packageName`.
     */
    async foreground(args) {
      const target = await selectDevice('device_foreground', args.serial);
      if (target.ok !== true) return target;
      const { adb, device } = target;
      const result = await adb.run(['shell', 'dumpsys', 'activity', 'activities'], {
        serial: device.serial,
        timeoutMs: adb.timeouts.default,
      });
      if (result.timedOut) return adbCommandFailure('device_foreground', result, 'The device may be busy; retry.');
      const output = String(result.stdout ?? '');
      const match = /(?:mResumedActivity|topResumedActivity|mFocusedApp)[^\n]*?\s([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/u.exec(output);
      if (match === null) {
        return failure(
          ErrorCodes.PACKAGE_NOT_FOUND,
          `No foreground app found on ${device.serial}.`,
          'Open the app on the device first, or pass an explicit package name.',
          { serial: device.serial },
        );
      }
      return success('device_foreground', { serial: device.serial, packageName: match[1] });
    },

    /**
     * `device_stop`: force-stop a package.
     *
     * @param {{ serial?: string, packageName: string }} args Validated arguments.
     * @returns {Promise<Record<string, unknown>>} result envelope.
     */
    async stop(args) {
      const target = await selectDevice('device_stop', args.serial);
      if (target.ok !== true) return target;
      const result = await target.adb.run(['shell', 'am', 'force-stop', args.packageName], {
        serial: target.device.serial,
        timeoutMs: target.adb.timeouts.default,
      });
      if (!result.ok) return adbCommandFailure('device_stop', result, 'Retry; force-stop normally succeeds silently.');
      return success('device_stop', { serial: target.device.serial, packageName: args.packageName });
    },

    /**
     * `device_clear_data`: clear one app's data with `pm clear`.
     *
     * @param {{ serial?: string, packageName: string }} args Validated arguments.
     * @returns {Promise<Record<string, unknown>>} result envelope.
     */
    async clearData(args) {
      const target = await selectDevice('device_clear_data', args.serial);
      if (target.ok !== true) return target;
      const result = await target.adb.run(['shell', 'pm', 'clear', args.packageName], {
        serial: target.device.serial,
        timeoutMs: target.adb.timeouts.default,
      });
      const output = combinedOutput(result);
      if (result.timedOut) return adbCommandFailure('device_clear_data', result, 'Retry; pm clear hung on the device.');
      if (!result.ok || !clearSucceeded(output)) {
        return failure(
          ErrorCodes.PACKAGE_NOT_FOUND,
          `pm clear failed for "${args.packageName}" on ${target.device.serial}: ${firstMeaningfulLine(output) || 'no output'}`,
          'Confirm the package is installed on that device with fleet_list (packageName=<pkg>).',
          { serial: target.device.serial, packageName: args.packageName, output: limit(output, 1_500) },
        );
      }
      return success('device_clear_data', { serial: target.device.serial, packageName: args.packageName, output: 'Success' });
    },

    /**
     * `device_screenshot`: capture a PNG into the plugin temp directory.
     *
     * @param {{ serial?: string }} args Validated arguments.
     * @returns {Promise<Record<string, unknown>>} result envelope.
     */
    async screenshot(args) {
      const target = await selectDevice('device_screenshot', args.serial);
      if (target.ok !== true) return target;
      return captureScreenshot({ adb: target.adb, serial: target.device.serial, tmpRoot, now: now() });
    },

    /**
     * `device_logcat`: bounded logcat snapshot with presets and an optional substring filter.
     *
     * @param {{ serial?: string, preset?: string, filter?: string, lines?: number }} args Validated arguments.
     * @returns {Promise<Record<string, unknown>>} result envelope.
     */
    async logcat(args) {
      const target = await selectDevice('device_logcat', args.serial);
      if (target.ok !== true) return target;
      const preset = /** @type {keyof typeof LOGCAT_PRESETS} */ (args.preset ?? 'all');
      const tailLimit = args.lines ?? 200;
      const result = await target.adb.run(['logcat', '-d', '-t', String(FETCH_LINE_CAP)], {
        serial: target.device.serial,
        timeoutMs: target.adb.timeouts.logcat,
      });
      if (result.timedOut) return adbCommandFailure('device_logcat', result, 'The device log is busy; retry with fewer lines.');
      const output = combinedOutput(result);
      if (!result.ok) {
        return failure(
          ErrorCodes.ADB_FAILED,
          `logcat snapshot on ${target.device.serial} failed`,
          'Retry; if it repeats, check that the device is authorized and awake.',
          { serial: target.device.serial, stderr: limit(String(result.stderr), 1_000) },
        );
      }
      const selection = selectLogcatLines(splitLogLines(output), { preset, filter: args.filter, limit: tailLimit });
      /** @type {Record<string, unknown>} */
      const payload = {
        serial: target.device.serial,
        preset: selection.preset,
        presetLabel: selection.presetLabel,
        total: selection.total,
        matched: selection.matched,
        lines: selection.lines,
        truncated: selection.truncated,
        hint: LOGCAT_PRESETS[preset].hint,
      };
      if (selection.filter !== undefined) payload.filter = selection.filter;
      return success('device_logcat', payload);
    },

    /**
     * `device_deep_link`: open a deep link with `am start -a VIEW`.
     *
     * @param {{ serial?: string, url: string }} args Validated arguments.
     * @returns {Promise<Record<string, unknown>>} result envelope.
     */
    async deepLink(args) {
      const url = args.url.trim();
      if (url.length > 2_048) {
        return failure(ErrorCodes.INVALID_ARGUMENT, 'url is longer than 2048 characters', 'Use a shorter deep link.');
      }
      if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(url) || /[\s\u0000-\u001f]/u.test(url)) {
        return failure(
          ErrorCodes.INVALID_ARGUMENT,
          `"${limit(url, 120)}" is not a valid deep link URL`,
          'Pass an absolute URL with a scheme, for example https://example.com/path or myapp://screen/42.',
        );
      }
      const target = await selectDevice('device_deep_link', args.serial);
      if (target.ok !== true) return target;
      const result = await target.adb.run(
        ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url],
        { serial: target.device.serial, timeoutMs: target.adb.timeouts.default },
      );
      const output = combinedOutput(result);
      if (result.timedOut) return adbCommandFailure('device_deep_link', result, 'am start hung; retry once.');
      if (!result.ok || /^Error|exception|not found/imu.test(output)) {
        return failure(
          ErrorCodes.ADB_FAILED,
          `Deep link failed on ${target.device.serial}: ${firstMeaningfulLine(output) || 'no matching activity'}`,
          'Check that an installed app handles this scheme; the URL scheme must be registered by the app.',
          { serial: target.device.serial, url, output: limit(output, 1_500) },
        );
      }
      return success('device_deep_link', { serial: target.device.serial, url, output: limit(output.trim(), 1_500) });
    },

    /**
     * `device_shell`: run one allowlisted, metacharacter-free shell command.
     *
     * @param {{ serial: string, command: string }} args Validated arguments.
     * @returns {Promise<Record<string, unknown>>} result envelope.
     */
    async shell(args) {
      const policy = validateShellCommand(args.command);
      if (policy.ok !== true) return policy.failure;
      const target = await selectDevice('device_shell', args.serial);
      if (target.ok !== true) return target;
      const result = await target.adb.run(['shell', ...policy.argv], {
        serial: target.device.serial,
        timeoutMs: target.adb.timeouts.shell,
      });
      const stdout = String(result.stdout ?? '');
      const stderr = String(result.stderr ?? '');
      if (result.spawnError !== undefined) return missingAdbFailure(target.adb.adbPath);
      if (result.timedOut) return adbCommandFailure('device_shell', result, 'The command hit the 10 s timeout; narrow it.');
      if (!result.ok) {
        return failure(
          ErrorCodes.SHELL_COMMAND_FAILED,
          `"${args.command}" failed on ${target.device.serial} with exit code ${result.code}`,
          'Read details.output for the device error; adjust the command and retry.',
          { serial: target.device.serial, command: args.command, exitCode: result.code, stdout: limit(stdout, 2_000), stderr: limit(stderr, 2_000) },
        );
      }
      return success('device_shell', {
        serial: target.device.serial,
        command: args.command,
        argv: policy.argv,
        exitCode: result.code,
        stdout: limit(stdout, 4_000),
        stderr: limit(stderr, 1_000),
      });
    },

    /**
     * `device_pull`: copy one device file into the plugin temp directory.
     *
     * @param {{ serial?: string, remotePath: string }} args Validated arguments.
     * @returns {Promise<Record<string, unknown>>} result envelope.
     */
    async pull(args) {
      const remote = args.remotePath.trim();
      if (!/^\/[A-Za-z0-9 ._/:,+@=-]*$/u.test(remote) || remote.includes('..') || remote.length > 1_024) {
        return failure(
          ErrorCodes.INVALID_ARGUMENT,
          `"${limit(remote, 120)}" is not a safe absolute device path`,
          'Pass an absolute path on the device, for example /sdcard/Download/screenshot.png (letters, digits, . _ / : , + @ = - only, no ..).',
        );
      }
      const target = await selectDevice('device_pull', args.serial);
      if (target.ok !== true) return target;
      const directory = path.join(tmpRoot, PLUGIN_TEMP_DIR, 'pulls');
      await mkdir(directory, { recursive: true });
      const base = path.basename(remote).replace(/[^A-Za-z0-9._-]+/gu, '_') || 'pull.bin';
      const targetPath = path.join(directory, `${new Date(now()).toISOString().replace(/[:.]/gu, '-')}-${base}`);
      const result = await target.adb.run(['pull', remote, targetPath], {
        serial: target.device.serial,
        timeoutMs: target.adb.timeouts.pull,
      });
      if (isMissingExecutable(result)) return missingAdbFailure(target.adb.adbPath);
      if (result.timedOut) {
        return failure(ErrorCodes.ADB_TIMEOUT, `adb pull from ${target.device.serial} timed out`, 'Retry with a smaller file.', {
          serial: target.device.serial,
          remotePath: remote,
        });
      }
      if (!result.ok) {
        return failure(
          ErrorCodes.PULL_FAILED,
          `adb pull failed for ${remote} on ${target.device.serial}`,
          'Check the path exists on the device and is readable without root.',
          { serial: target.device.serial, remotePath: remote, output: limit(combinedOutput(result), 1_000) },
        );
      }
      let bytes;
      try {
        bytes = (await stat(targetPath)).size;
      } catch {
        return failure(ErrorCodes.PULL_FAILED, `adb pull reported success but ${remote} was not written locally`, 'Retry the pull.', {
          serial: target.device.serial,
          remotePath: remote,
        });
      }
      return success('device_pull', { serial: target.device.serial, remotePath: remote, path: targetPath, bytes });
    },

    /**
     * `device_which`: report how adb, the SDK, emulator, java, and flutter resolve.
     *
     * @returns {Promise<Record<string, unknown>>} result envelope.
     */
    async which() {
      const location = discover();
      const emulator = options.emulatorPath !== undefined ? { path: options.emulatorPath, source: 'configured' } : resolveEmulator({ env, platform, home, exists });
      const java = resolveJava({ env, platform, home, exists });
      const flutter = resolveFlutter({ env, platform, home, exists });
      const sdk = findAndroidSdk({ env, platform, home, exists });
      /** @type {{ version?: string } | undefined} */
      let adbVersion;
      if (location !== undefined) {
        try {
          const runner = runnerCache !== undefined && runnerCache.path === location.path
            ? runnerCache.runner
            : createAdbRunner({
                adbPath: location.path,
                ...(spawn === undefined ? {} : { spawn }),
                ...(timeouts === undefined ? {} : { timeouts }),
                env,
                platform,
              });
          const probe = await runner.run(['version'], { timeoutMs: 5_000 });
          adbVersion = runnerVersion(probe);
        } catch {
          adbVersion = undefined;
        }
      }
      return success('device_which', {
        platform,
        adb: location === undefined ? { found: false, hint: 'Install Android platform-tools or set ANDROID_HOME.' } : { found: true, path: location.path, source: location.source, version: adbVersion?.version },
        androidSdk: sdk === undefined ? { found: false, hint: 'Set ANDROID_HOME to your Android SDK directory.' } : { found: true, path: sdk.root, source: sdk.source },
        emulator: emulator === undefined ? { found: false, hint: 'Install an Android emulator + AVD, or use a physical device.' } : { found: true, path: emulator.path, source: emulator.source },
        java: java === undefined ? { found: false, hint: 'Install a JDK or set JAVA_HOME.' } : { found: true, path: java.path, source: java.source },
        flutter: flutter === undefined ? { found: false, hint: 'Install Flutter and add it to PATH.' } : { found: true, path: flutter.path, source: flutter.source },
      });
    },

    /**
     * `emulator_start`: boot one AVD detached.
     *
     * @param {{ avdName: string }} args Validated arguments.
     * @returns {Promise<Record<string, unknown>>} result envelope.
     */
    async emulatorStart(args) {
      const avdName = args.avdName.trim();
      if (avdName === '' || avdName.length > 64 || !/^[A-Za-z0-9._ -]+$/u.test(avdName)) {
        return failure(
          ErrorCodes.INVALID_ARGUMENT,
          `"${limit(avdName, 80)}" is not a valid AVD name`,
          'Pass the AVD name exactly as `emulator -list-avds` prints it.',
        );
      }
      const emulatorLocation = options.emulatorPath !== undefined ? { path: options.emulatorPath, source: 'configured' } : resolveEmulator({ env, platform, home, exists });
      if (emulatorLocation === undefined) {
        return failure(
          ErrorCodes.EMULATOR_NOT_FOUND,
          'The Android emulator executable was not found.',
          'Install the Android Emulator through Android Studio SDK Manager and set ANDROID_HOME, or connect a physical device instead.',
          { expected: path.join('<ANDROID_HOME>', 'emulator', platform === 'win32' ? 'emulator.exe' : 'emulator') },
        );
      }
      const runner = createEmulatorRunner({
        emulatorPath: emulatorLocation.path,
        ...(spawn === undefined ? {} : { spawn }),
        ...(timeouts === undefined ? {} : { timeouts }),
        env,
      });
      const avds = await runner.listAvds();
      if (avds.ok !== true) {
        return failure(ErrorCodes.EMULATOR_FAILED, `Could not list AVDs: ${avds.error}`, 'Run `emulator -list-avds` in a terminal to diagnose.', {
          emulatorPath: emulatorLocation.path,
        });
      }
      if (!avds.avds.includes(avdName)) {
        return failure(
          ErrorCodes.EMULATOR_NOT_FOUND,
          `No AVD named "${avdName}" exists.`,
          avds.avds.length === 0 ? 'Create an AVD in Android Studio Device Manager first.' : `Available AVDs: ${avds.avds.join(', ')}.`,
          { available: avds.avds },
        );
      }
      const started = await runner.start(avdName);
      if (started.ok !== true) {
        return failure(ErrorCodes.EMULATOR_FAILED, `Could not start AVD "${avdName}": ${started.error}`, 'Run the emulator manually to see its full error.', {
          avdName,
          emulatorPath: emulatorLocation.path,
        });
      }
      return success('emulator_start', {
        avdName,
        ...(started.pid === undefined ? {} : { pid: started.pid }),
        emulatorPath: emulatorLocation.path,
        hint: 'The AVD boots in 20-60 s. Call fleet_list until an emulator-<port> serial shows state "device".',
      });
    },

    /**
     * `emulator_stop`: kill one running emulator.
     *
     * @param {{ serial: string }} args Validated arguments.
     * @returns {Promise<Record<string, unknown>>} result envelope.
     */
    /**
     * `adb_restart`: cleanly restart the local adb server and re-list devices.
     *
     * A stale adb server can leave a physically connected phone invisible until
     * the server is restarted; this is the explicit, user-driven recovery.
     *
     * @returns {Promise<Record<string, unknown>>} result envelope.
     */
    async restartAdb() {
      const runner = adbRunner();
      if (runner === undefined) return missingAdbFailure();
      const serverTimeout = timeouts?.server ?? 10_000;
      const stopped = await runner.run(['kill-server'], { timeoutMs: serverTimeout });
      const started = await runner.run(['start-server'], { timeoutMs: serverTimeout + 5_000 });
      if (started.ok !== true) {
        return adbCommandFailure('adb_restart', started, 'adb start-server failed; check that port 5037 is free and no other program is restarting adb.');
      }
      const listing = await /** @type {any} */ (this).list({});
      return success('adb_restart', {
        stopped: stopped.ok === true,
        started: true,
        devices: Array.isArray(listing.devices) ? listing.devices.length : 0,
      });
    },

    /**
     * `device_mirror`: open a read-only scrcpy window for one device.
     *
     * The mirror is control-free (`--no-control`) by design: the panel shows
     * the screen, while input stays on the physical device or emulator.
     *
     * @param {{ serial?: string }} args Validated arguments.
     * @returns {Promise<Record<string, unknown>>} result envelope.
     */
    async mirror(args) {
      const target = await selectDevice('device_mirror', args.serial);
      if (target.ok !== true) return target;
      const binary = scrcpyPath !== undefined && scrcpyPath !== null ? scrcpyPath : resolveScrcpy({ env, platform, exists });
      if (binary === null || binary === undefined) {
        return failure(
          ErrorCodes.SCRCPY_NOT_FOUND,
          'scrcpy was not found on this machine.',
          'Install it with "winget install Genymobile.scrcpy", put scrcpy on PATH, or set the SCRCPY environment variable, then retry.',
          { serial: target.device.serial },
        );
      }
      const launched = spawnDetached(binary, ['--no-control', '--window-title', 'DSH device mirror', '-s', target.device.serial]);
      if (launched.ok !== true) {
        return failure(
          ErrorCodes.SCRCPY_FAILED,
          `scrcpy failed to start: ${launched.error ?? 'unknown error'}`,
          'Run scrcpy once from a terminal to confirm it works, or set SCRCPY to its full path.',
          { serial: target.device.serial },
        );
      }
      return success('device_mirror', { serial: target.device.serial, launched: true, pid: launched.pid });
    },

    /**
     * Capabilities the panel asks for: whether scrcpy is available for mirroring.
     *
     * @returns {Record<string, unknown>} success envelope.
     */
    capabilities() {
      const binary = scrcpyPath !== undefined && scrcpyPath !== null ? scrcpyPath : resolveScrcpy({ env, platform, exists });
      return success('device_capabilities', {
        scrcpy: { available: binary !== null && binary !== undefined, path: binary ?? null },
      });
    },

    /**
     * `emulator_stop`: terminate one running emulator instance.
     *
     * @param {{ serial: string }} args Validated arguments.
     * @returns {Promise<Record<string, unknown>>} result envelope.
     */
    async emulatorStop(args) {
      const target = await selectDevice('emulator_stop', args.serial, { requireSerial: true, requireEmulator: true });
      if (target.ok !== true) return target;
      const result = await target.adb.run(['emu', 'kill'], { serial: target.device.serial, timeoutMs: target.adb.timeouts.default });
      if (result.timedOut) return adbCommandFailure('emulator_stop', result, 'The emulator is not responding; close it from the window.');
      if (!result.ok) {
        return failure(ErrorCodes.EMULATOR_FAILED, `Could not stop emulator ${target.device.serial}`, 'Close the emulator window manually if it is stuck.', {
          serial: target.device.serial,
          output: limit(combinedOutput(result), 1_000),
        });
      }
      return success('emulator_stop', { serial: target.device.serial, output: limit(combinedOutput(result).trim(), 500) });
    },
  };
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Failure for a machine without adb.
 *
 * @param {string} [foundAt] Path that was found but not runnable.
 * @returns {ReturnType<typeof failure>} ADB_NOT_FOUND failure.
 */
function missingAdbFailure(foundAt) {
  const expected = process.platform === 'win32' ? 'C:\\Users\\<you>\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe' : '<ANDROID_HOME>/platform-tools/adb';
  return failure(
    ErrorCodes.ADB_NOT_FOUND,
    foundAt === undefined ? 'adb was not found on this machine.' : `adb at ${foundAt} could not be executed.`,
    'Install Android platform-tools (Android Studio > SDK Manager > SDK Tools) or set ANDROID_HOME to your Android SDK; adb lives in <sdk>/platform-tools and must be on PATH or found there.',
    {
      expected,
      checked: {
        ANDROID_HOME: process.env.ANDROID_HOME ?? null,
        ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT ?? null,
        PATH: 'searched for adb/adb.exe',
      },
    },
  );
}

/**
 * Failure for a failed adb command.
 *
 * @param {string} tool Wire tool name.
 * @param {import('./adb.js').AdbRunResult | undefined} result Failed run.
 * @param {string} [hint] Suggested next action.
 * @returns {ReturnType<typeof failure>} mapped failure.
 */
function adbCommandFailure(tool, result, hint) {
  if (result === undefined) {
    return failure(ErrorCodes.ADB_NOT_FOUND, `${tool}: adb could not be started.`, 'Install Android platform-tools or fix ANDROID_HOME.');
  }
  if (isMissingExecutable(result)) return missingAdbFailure();
  if (result.timedOut) {
    return failure(ErrorCodes.ADB_TIMEOUT, `${tool}: adb command timed out.`, hint ?? 'Retry once; if it repeats, reconnect the device.', {
      code: result.code,
      stderr: limit(String(result.stderr), 500),
    });
  }
  return failure(
    ErrorCodes.ADB_FAILED,
    `${tool}: adb command failed (exit ${String(result.code)})`,
    hint ?? 'Check the device connection and `adb devices` output.',
    { code: result.code, stderr: limit(String(result.stderr), 1_000), stdout: limit(String(result.stdout), 500) },
  );
}

/**
 * Failure for a connected but unusable device.
 *
 * @param {string} tool Wire tool name.
 * @param {import('./parse.js').AdbDevice} device Parsed device.
 * @returns {ReturnType<typeof failure>} failure envelope.
 */
function notReadyFailure(tool, device) {
  if (device.state === 'unauthorized') {
    return failure(
      ErrorCodes.DEVICE_UNAUTHORIZED,
      `${device.model ?? device.serial} is unauthorized; the RSA prompt has not been accepted.`,
      `Unlock ${device.model ?? 'the device'}, tap "Allow USB debugging" (check "Always allow"), then retry ${tool}.`,
      { device: deviceSummary(device) },
    );
  }
  return failure(
    ErrorCodes.DEVICE_OFFLINE,
    `${device.serial} is ${device.state}, not ready for commands.`,
    'Reconnect the USB cable or restart the emulator, then retry fleet_list.',
    { device: deviceSummary(device) },
  );
}

/**
 * Failure when no connected device is ready.
 *
 * @param {string} tool Wire tool name.
 * @param {import('./parse.js').AdbDevice[]} devices All connected devices.
 * @returns {ReturnType<typeof failure>} failure envelope.
 */
function noReadyDevicesFailure(tool, devices) {
  const unauthorized = devices.filter((device) => device.state === 'unauthorized');
  if (unauthorized.length > 0) {
    const device = unauthorized[0];
    return failure(
      ErrorCodes.DEVICE_UNAUTHORIZED,
      `${tool}: ${device.model ?? device.serial} is unauthorized.`,
      `Unlock ${device.model ?? 'the device'} and tap "Allow USB debugging", then retry.`,
      { devices: devices.map(deviceSummary) },
    );
  }
  return failure(ErrorCodes.NO_DEVICES, `${tool}: no device is ready for commands.`, 'Call fleet_list to inspect connection states.', {
    devices: devices.map(deviceSummary),
  });
}

/**
 * Validate an APK path before any adb work.
 *
 * @param {string} apkPath Supplied path.
 * @returns {Promise<{ ok: true, path: string, bytes: number } | ReturnType<typeof failure>>} resolved APK or failure.
 */
async function validateApk(apkPath) {
  const resolved = path.resolve(apkPath.trim());
  if (!resolved.toLowerCase().endsWith('.apk')) {
    return failure(ErrorCodes.APK_INVALID, `"${limit(apkPath, 160)}" is not an .apk file`, 'Pass the path to a built debug APK, for example build/app/outputs/flutter-apk/app-debug.apk.');
  }
  let info;
  try {
    info = await stat(resolved);
  } catch {
    return failure(ErrorCodes.APK_NOT_FOUND, `APK not found at ${resolved}`, 'Check the path; relative paths resolve from the DSH host process working directory, so prefer an absolute path.', {
      apkPath: resolved,
    });
  }
  if (!info.isFile()) {
    return failure(ErrorCodes.APK_INVALID, `${resolved} is not a file`, 'Pass the APK file path.');
  }
  if (info.size < 4) {
    return failure(ErrorCodes.APK_INVALID, `${resolved} is too small to be an APK`, 'Rebuild the APK and retry.');
  }
  /** @type {Buffer} */
  const header = Buffer.alloc(4);
  try {
    const handle = await open(resolved, 'r');
    try {
      await handle.read(header, 0, 4, 0);
    } finally {
      await handle.close();
    }
  } catch (error) {
    return failure(ErrorCodes.APK_INVALID, `Cannot read ${resolved}: ${error instanceof Error ? error.message : String(error)}`, 'Check file permissions.');
  }
  // An APK is a ZIP archive; ZIP files start with "PK\x03\x04".
  if (header.toString('latin1') !== 'PK\u0003\u0004') {
    return failure(ErrorCodes.APK_INVALID, `${resolved} is not a valid APK (missing ZIP signature)`, 'Rebuild the APK; the file may be corrupted or an AAB.');
  }
  return { ok: true, path: resolved, bytes: info.size };
}

/**
 * Small model-facing device summary for error details.
 *
 * @param {import('./parse.js').AdbDevice} device Parsed device.
 * @returns {{ serial: string, state: string, model?: string }} summary.
 */
function deviceSummary(device) {
  return { serial: device.serial, state: device.state, ...(device.model === undefined ? {} : { model: device.model }) };
}

/**
 * Join stdout and stderr into one searchable text.
 *
 * @param {import('./adb.js').AdbRunResult} result Run result.
 * @returns {string} combined output.
 */
function combinedOutput(result) {
  return `${String(result.stdout ?? '')}${String(result.stderr ?? '')}`;
}

/**
 * Truncate text to a maximum length, marking the cut.
 *
 * @param {string} text Input text.
 * @param {number} max Maximum characters.
 * @returns {string} bounded text.
 */
function limit(text, max) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, max)}… [truncated]`;
}

/**
 * First non-empty, meaningful line of adb output.
 *
 * @param {string} output Combined output.
 * @returns {string} one line, bounded.
 */
function firstMeaningfulLine(output) {
  for (const line of String(output).split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed !== '') return limit(trimmed, 220);
  }
  return '';
}

/**
 * Extract the most useful failure line from adb install output.
 *
 * @param {string} output Combined output.
 * @returns {string} bounded failure line.
 */
function installFailureLine(output) {
  const failure = /Failure \[[^\]]+\][^\n]*/u.exec(output);
  if (failure !== null) return failure[0].trim();
  return firstMeaningfulLine(output) || 'unknown install failure';
}

/**
 * Map install failure signatures to a suggested action.
 *
 * @param {string} output Combined adb install output.
 * @returns {string} hint.
 */
function installHint(output) {
  if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/iu.test(output)) {
    return 'An app with a different signature is installed. Uninstall the existing app on that device (adb uninstall <pkg>) or clear its data first, then retry.';
  }
  if (/INSTALL_FAILED_INSUFFICIENT_STORAGE/iu.test(output)) {
    return 'The device is out of storage. Free space on the device, then retry.';
  }
  if (/INSTALL_FAILED_VERSION_DOWNGRADE/iu.test(output)) {
    return 'The installed version is newer. Use a higher versionCode or uninstall the existing app first.';
  }
  if (/INSTALL_FAILED_USER_RESTRICTED|INSTALL_CANCELED_BY_USER/iu.test(output)) {
    return 'The device blocked the install. Accept the install prompt on the phone and retry.';
  }
  if (/no devices\/emulators found|device offline|device unauthorized/iu.test(output)) {
    return 'The device dropped off. Reconnect it, unlock it, and confirm the USB debugging prompt.';
  }
  return 'Read details.output for the adb install error; the APK or device compatibility is likely the cause.';
}

/**
 * Extract a version string from `adb version` output.
 *
 * @param {import('./adb.js').AdbRunResult} result Version run.
 * @returns {{ version?: string }} parsed version.
 */
function runnerVersion(result) {
  const match = /Android Debug Bridge version\s+(\S+)/u.exec(`${String(result.stdout ?? '')}${result.stderr ?? ''}`);
  return match === null ? {} : { version: match[1] };
}

/**
 * Parse a numeric property.
 *
 * @param {string | undefined} value String value.
 * @returns {number | undefined} parsed integer.
 */
function toInteger(value) {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
