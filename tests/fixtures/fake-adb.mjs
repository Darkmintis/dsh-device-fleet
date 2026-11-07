#!/usr/bin/env node
/**
 * Real-process fake adb.
 *
 * The in-process tests use `fake-adb-handler.mjs` directly; this wrapper exists
 * for manual verification of the production adb runner (spawn, capture,
 * timeouts) without a connected device:
 *
 *   node tests/fixtures/fake-adb.mjs devices -l
 *   $env:FAKE_ADB_SCENARIO='multi'; node tests/fixtures/fake-adb.mjs -s R58M12345 shell getprop
 */

import { runFakeAdb } from './fake-adb-handler.mjs';

const result = runFakeAdb(process.argv.slice(2), process.env);
if (result.hang === true) {
  setTimeout(() => {}, 60_000);
} else {
  if (result.stdout !== undefined) process.stdout.write(result.stdout);
  if (result.stderr !== undefined) process.stderr.write(result.stderr);
  process.exit(result.code ?? 0);
}
