/**
 * In-process fake adb process used by the integration tests.
 *
 * The production runner's `spawn` seam receives a ChildProcess-shaped object
 * backed by EventEmitter and PassThrough streams. That keeps the tests
 * deterministic and runnable inside restricted shells that forbid spawning
 * piped child processes, while still exercising capture, timeout, kill, and
 * close handling in `lib/adb.js`.
 *
 * @module
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runFakeAdb } from '../fixtures/fake-adb-handler.mjs';

/**
 * @typedef {import('node:child_process').ChildProcess} ChildProcess
 */

/**
 * Create a ChildProcess-shaped fake.
 *
 * @param {(args: readonly string[], options: any) => import('../fixtures/fake-adb-handler.mjs').FakeAdbResult} script Scripted behavior.
 * @returns {(command: string, args: readonly string[], options: any) => ChildProcess} spawn implementation.
 */
export function createFakeSpawn(script = runFakeAdb) {
  return (command, args, options) => {
    const child = /** @type {any} */ (new EventEmitter());
    child.pid = 4242;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let closed = false;
    /**
     * @param {number | null} code Exit code.
     * @param {NodeJS.Signals | null} [signal] Signal.
     */
    const close = (code, signal = null) => {
      if (closed) return;
      closed = true;
      child.stdout.end();
      child.stderr.end();
      child.emit('close', code, signal);
    };
    child.kill = (signal = 'SIGKILL') => {
      queueMicrotask(() => close(null, signal));
      return true;
    };
    child.unref = () => {};
    child.ref = () => {};
    const result = script(args, options?.env ?? {});
    queueMicrotask(() => child.emit('spawn'));
    if (result.hang === true) {
      // The runner's timeout must call kill(), which closes the fake.
      return child;
    }
    const delay = result.delayMs ?? 0;
    setTimeout(() => {
      if (closed) return;
      if (result.stdout !== undefined) child.stdout.write(Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout));
      if (result.stderr !== undefined) child.stderr.write(String(result.stderr));
      close(result.code ?? 0);
    }, delay);
    return child;
  };
}
