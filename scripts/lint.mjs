#!/usr/bin/env node
/**
 * Zero-dependency lint gate for the device-fleet bundle.
 *
 * Syntax is covered by `npm run typecheck` (tsc parses every Host module) and by
 * `npm test`/`npm run build` executing the rest. This gate enforces the security
 * invariants that types cannot express:
 *
 * 1. Host code never spawns through a shell, eval, or dynamic Function.
 * 2. `child_process` is confined to `lib/adb.js`.
 * 3. The Web client half imports only React (no Harness internals).
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');

/** Patterns banned across all shipped Host code. */
const BANNED = [
  { pattern: /\bshell\s*:\s*true\b/u, reason: 'spawning through a shell is forbidden; adb argv must be passed directly' },
  { pattern: /\bexecSync\s*\(/u, reason: 'execSync blocks the host event loop' },
  { pattern: /\beval\s*\(/u, reason: 'eval is forbidden' },
  { pattern: /\bnew\s+Function\s*\(/u, reason: 'dynamic Function construction is forbidden' },
];

/**
 * Recursively collect files with one of the given extensions.
 *
 * @param {string} directory Directory to walk.
 * @param {readonly string[]} extensions Extensions to keep.
 * @returns {Promise<string[]>} absolute file paths.
 */
async function collect(directory, extensions) {
  /** @type {string[]} */
  const files = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      files.push(...(await collect(target, extensions)));
    } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      files.push(target);
    }
  }
  return files;
}

const hostFiles = [...(await collect(path.join(root, 'lib'), ['.js'])), path.join(root, 'index.js')];
let failures = 0;

/**
 * @param {string} message Failure message.
 */
function fail(message) {
  failures += 1;
  console.error(`  ✗ ${message}`);
}

for (const file of hostFiles) {
  const relative = path.relative(root, file);
  const text = await readFile(file, 'utf8');
  for (const rule of BANNED) {
    if (rule.pattern.test(text)) fail(`${relative}: ${rule.reason}`);
  }
  const importsChildProcess = /from\s+['"]node:child_process['"]/u.test(text) || /require\(\s*['"]node:child_process['"]\s*\)/u.test(text);
  if (importsChildProcess && path.basename(file) !== 'adb.js') {
    fail(`${relative}: child_process is only allowed in lib/adb.js`);
  }
}
console.log(`security: ${hostFiles.length} Host file(s) checked`);

const clientPath = path.join(root, 'client.js');
try {
  const client = await readFile(clientPath, 'utf8');
  const requires = [...client.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/gu)].map((match) => match[1]);
  for (const specifier of requires) {
    if (specifier !== 'react' && specifier !== 'react/jsx-runtime') {
      fail(`client.js requires forbidden module "${specifier}" (only react is allowed in the Web client)`);
    }
  }
  if (!client.includes("id: '@darkmintis/dsh-device-fleet'")) fail("client.js must load with id '@darkmintis/dsh-device-fleet'");
  console.log('client: Web half imports only React');
} catch {
  fail('client.js is missing (the Web half must ship in v0.1.0)');
}

if (failures > 0) {
  console.error(`lint failed with ${failures} problem(s)`);
  process.exit(1);
}
console.log('lint ok');
