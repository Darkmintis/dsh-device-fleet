/**
 * Bounded, non-blocking adb process runner.
 *
 * adb is always executed as a child process with captured stdout/stderr and an
 * explicit timeout; no shell is involved, so arguments cannot be re-interpreted
 * by cmd.exe or a POSIX shell. Every method resolves with a plain result object
 * and never rejects, which keeps tool handlers straightforward.
 *
 * @module
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { parseAvdList, parseDeviceList } from './parse.js';

/** Default per-operation timeouts in milliseconds. */
export const TIMEOUTS = Object.freeze({
  default: 10_000,
  install: 20_000,
  screenshot: 15_000,
  logcat: 15_000,
  pull: 30_000,
  shell: 10_000,
  server: 10_000,
  emulator: 10_000,
});

/** Output ceilings keep a misbehaving device from exhausting host memory. */
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_BINARY_BYTES = 32 * 1024 * 1024;

/**
 * @typedef {object} AdbRunResult
 * @property {boolean} ok Whether adb exited 0 without timing out.
 * @property {number | null} code Exit code, or null when the process never started.
 * @property {string | Buffer} stdout Captured stdout.
 * @property {string} stderr Captured stderr.
 * @property {boolean} timedOut Whether the timeout killed the process.
 * @property {string} [spawnError] Spawn failure code when adb could not be started.
 * @property {string} [signal] Terminating signal, when any.
 */

/**
 * @typedef {object} AdbRunnerOptions
 * @property {string} adbPath Absolute path to the adb executable.
 * @property {typeof nodeSpawn} [spawn] Process spawn implementation (test seam).
 * @property {NodeJS.Platform} [platform] Target platform.
 * @property {NodeJS.ProcessEnv} [env] Environment for child processes.
 * @property {typeof TIMEOUTS} [timeouts] Timeout table override.
 */

/**
 * Create an adb runner bound to one executable.
 *
 * @param {AdbRunnerOptions} options Runner options.
 * @returns {ReturnType<typeof buildRunner>} runner instance.
 */
export function createAdbRunner(options) {
  if (typeof options.adbPath !== 'string' || options.adbPath === '') {
    throw new Error('createAdbRunner requires adbPath');
  }
  return buildRunner(options);
}

/**
 * @param {AdbRunnerOptions} options Runner options.
 */
function buildRunner(options) {
  const adbPath = options.adbPath;
  const spawn = options.spawn ?? nodeSpawn;
  const env = { ...(options.env ?? process.env) };
  const timeouts = options.timeouts ?? TIMEOUTS;

  /**
   * Run one adb command with a hard timeout and bounded capture.
   *
   * @param {readonly string[]} args Arguments after the optional serial selector.
   * @param {{ serial?: string, timeoutMs?: number, binary?: boolean, maxBytes?: number }} [runOptions] Run options.
   * @returns {Promise<AdbRunResult>} settled command result.
   */
  function run(args, runOptions = {}) {
    const serial = runOptions.serial;
    const timeoutMs = runOptions.timeoutMs ?? timeouts.default;
    const binary = runOptions.binary === true;
    const maxBytes = runOptions.maxBytes ?? (binary ? MAX_BINARY_BYTES : MAX_TEXT_BYTES);
    const fullArgs = serial === undefined ? [...args] : ['-s', serial, ...args];
    return new Promise((resolve) => {
      /** @type {import('node:child_process').ChildProcess | undefined} */
      let child;
      let settled = false;
      let timedOut = false;
      /** @type {Buffer[]} */
      const stdoutChunks = [];
      /** @type {Buffer[]} */
      const stderrChunks = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      /** @type {NodeJS.Timeout | undefined} */
      let timer;
      /** @type {NodeJS.Timeout | undefined} */
      let hardTimer;

      const stdout = () => Buffer.concat(stdoutChunks);
      const stderrText = () => Buffer.concat(stderrChunks).toString('utf8');

      /**
       * @param {Partial<AdbRunResult> & { ok: boolean, code: number | null }} payload Final result fields.
       */
      const finish = (payload) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (hardTimer !== undefined) clearTimeout(hardTimer);
        const bytes = stdout();
        resolve({
          ok: payload.ok,
          code: payload.code,
          stdout: binary ? bytes : bytes.toString('utf8'),
          stderr: stderrText(),
          timedOut: payload.timedOut ?? timedOut,
          ...(payload.spawnError === undefined ? {} : { spawnError: payload.spawnError }),
          ...(payload.signal === undefined ? {} : { signal: payload.signal }),
        });
      };

      try {
        child = spawn(adbPath, fullArgs, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env,
        });
      } catch (error) {
        finish({ ok: false, code: null, spawnError: /** @type {{ code?: string }} */ (error).code ?? 'SPAWN_FAILED' });
        return;
      }

      timer = setTimeout(() => {
        timedOut = true;
        try {
          child?.kill('SIGKILL');
        } catch {
          // The process may have exited between the timer firing and the kill.
        }
        hardTimer = setTimeout(() => finish({ ok: false, code: null }), 2_000);
      }, Math.max(1, timeoutMs));

      child.stdout?.on('data', (chunk) => {
        if (stdoutBytes >= maxBytes) return;
        stdoutBytes += chunk.length;
        stdoutChunks.push(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        if (stderrBytes >= maxBytes) return;
        stderrBytes += chunk.length;
        stderrChunks.push(chunk);
      });
      child.on('error', (error) => {
        finish({ ok: false, code: null, spawnError: /** @type {{ code?: string }} */ (error).code ?? 'SPAWN_FAILED' });
      });
      child.on('close', (code, signal) => {
        finish({ ok: code === 0 && !timedOut, code, signal: signal ?? undefined });
      });
    });
  }

  /**
   * List devices, starting the adb server once and retrying if the daemon is down.
   *
   * @returns {Promise<{ ok: true, devices: import('./parse.js').AdbDevice[], warnings: string[], serverStarted: boolean } | { ok: false, result: AdbRunResult | undefined, serverStarted: boolean }>} parsed device list.
   */
  async function listDevices() {
    let result = await run(['devices', '-l'], { timeoutMs: timeouts.default });
    let serverStarted = false;
    if (result.spawnError !== undefined) return { ok: false, result: undefined, serverStarted };
    if (!result.ok && needsServerStart(result)) {
      const started = await run(['start-server'], { timeoutMs: timeouts.server });
      serverStarted = started.ok;
      result = await run(['devices', '-l'], { timeoutMs: timeouts.default });
    }
    if (!result.ok) return { ok: false, result, serverStarted };
    const parsed = parseDeviceList(`${result.stdout}\n${result.stderr}`);
    return { ok: true, devices: parsed.devices, warnings: parsed.warnings, serverStarted };
  }

  /**
   * Start the adb server explicitly (used by `device_which` diagnostics).
   *
   * @returns {Promise<AdbRunResult>} start-server result.
   */
  function startServer() {
    return run(['start-server'], { timeoutMs: timeouts.server });
  }

  /**
   * Read adb version output.
   *
   * @returns {Promise<{ ok: boolean, version?: string }>} short version string.
   */
  async function version() {
    const result = await run(['version'], { timeoutMs: timeouts.default });
    const text = `${textOf(result.stdout)}${result.stderr}`;
    const match = /Android Debug Bridge version\s+(\S+)/u.exec(text);
    return match === null ? { ok: false } : { ok: true, version: match[1] };
  }

  return {
    adbPath,
    platform: options.platform ?? process.platform,
    timeouts,
    run,
    listDevices,
    startServer,
    version,
  };
}

/**
 * @param {string | Buffer} stdout Captured stdout.
 * @returns {string} stdout text.
 */
function textOf(stdout) {
  return typeof stdout === 'string' ? stdout : stdout.toString('utf8');
}

/**
 * Whether an adb failure means the local adb server is not running.
 *
 * @param {AdbRunResult} result Failed run.
 * @returns {boolean} true when `adb start-server` is worth trying.
 */
export function needsServerStart(result) {
  const text = `${textOf(result.stdout)}${result.stderr}`;
  return /cannot connect to daemon|daemon not running|server is not running|failed to start daemon|ADB server didn't ACK|adb server version .* doesn't match|error connecting to server/i.test(
    text,
  );
}

/**
 * Whether a run failed because the executable could not be found.
 *
 * @param {AdbRunResult} result Failed run.
 * @returns {boolean} true for ENOENT-style spawn failures.
 */
export function isMissingExecutable(result) {
  return result.spawnError === 'ENOENT';
}

/**
 * Create a runner for the Android emulator binary (AVD listing and detached boot).
 *
 * @param {{ emulatorPath: string, spawn?: typeof nodeSpawn, env?: NodeJS.ProcessEnv, timeouts?: typeof TIMEOUTS }} options Runner options.
 * @returns {{ listAvds: () => Promise<{ ok: true, avds: string[] } | { ok: false, error: string }>, start: (avdName: string) => Promise<{ ok: true, pid: number | undefined } | { ok: false, error: string }>, emulatorPath: string }} emulator runner.
 */
export function createEmulatorRunner(options) {
  const spawn = options.spawn ?? nodeSpawn;
  const env = { ...(options.env ?? process.env) };
  const timeouts = options.timeouts ?? TIMEOUTS;

  /**
   * @param {readonly string[]} args Emulator arguments.
   * @param {{ timeoutMs: number }} runOptions Timeout.
   * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, code: number | null, timedOut: boolean, spawnError?: string }>} result.
   */
  function run(args, runOptions) {
    return new Promise((resolve) => {
      /** @type {import('node:child_process').ChildProcess | undefined} */
      let child;
      let settled = false;
      let timedOut = false;
      /** @type {Buffer[]} */
      const stdout = [];
      /** @type {Buffer[]} */
      const stderr = [];
      /** @type {NodeJS.Timeout | undefined} */
      let timer;
      const finish = (/** @type {{ ok: boolean, code: number | null, spawnError?: string }} */ payload) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve({
          ...payload,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          timedOut,
        });
      };
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child?.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }, Math.max(1, runOptions.timeoutMs));
      try {
        child = spawn(options.emulatorPath, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
      } catch (error) {
        finish({ ok: false, code: null, spawnError: /** @type {{ code?: string }} */ (error).code ?? 'SPAWN_FAILED' });
        return;
      }
      child.stdout?.on('data', (chunk) => stdout.push(chunk));
      child.stderr?.on('data', (chunk) => stderr.push(chunk));
      child.on('error', (error) => finish({ ok: false, code: null, spawnError: /** @type {{ code?: string }} */ (error).code ?? 'SPAWN_FAILED' }));
      child.on('close', (code) => finish({ ok: code === 0 && !timedOut, code }));
    });
  }

  return {
    emulatorPath: options.emulatorPath,
    async listAvds() {
      const result = await run(['-list-avds'], { timeoutMs: timeouts.emulator });
      if (!result.ok) return { ok: false, error: result.spawnError ?? result.stderr.trim() ?? 'emulator -list-avds failed' };
      return { ok: true, avds: parseAvdList(result.stdout) };
    },
    /**
     * Launch one AVD without waiting for boot: the emulator is detached and
     * polling for the device is the caller's job.
     *
     * @param {string} avdName Validated AVD name.
     * @returns {Promise<{ ok: true, pid: number | undefined } | { ok: false, error: string }>} spawn outcome.
     */
    start(avdName) {
      return new Promise((resolve) => {
        /** @type {import('node:child_process').ChildProcess | undefined} */
        let child;
        let settled = false;
        const finish = (/** @type {{ ok: true, pid: number | undefined } | { ok: false, error: string }} */ payload) => {
          if (settled) return;
          settled = true;
          resolve(payload);
        };
        try {
          child = spawn(options.emulatorPath, ['-avd', avdName, '-no-snapshot-save'], {
            windowsHide: true,
            stdio: 'ignore',
            detached: true,
            env,
          });
        } catch (error) {
          finish({ ok: false, error: error instanceof Error ? error.message : String(error) });
          return;
        }
        child.on('error', (error) => finish({ ok: false, error: error.message }));
        child.on('spawn', () => {
          child?.unref();
          finish({ ok: true, pid: child?.pid });
        });
      });
    },
  };
}
