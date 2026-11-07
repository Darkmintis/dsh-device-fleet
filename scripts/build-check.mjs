#!/usr/bin/env node
/**
 * Build gate for a zero-build Host bundle: there is nothing to compile, so the
 * "build" proves the published package is complete and loadable.
 *
 * Checks the manifest contract, the bundle patch, locale/icon assets, and that
 * every runtime module imports cleanly under Node 24.
 */

import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');

/**
 * @param {string} relative Path relative to the package root.
 * @returns {Promise<boolean>} whether the path exists.
 */
async function exists(relative) {
  try {
    await access(path.join(root, relative));
    return true;
  } catch {
    return false;
  }
}

let failures = 0;

/**
 * @param {boolean} condition Check result.
 * @param {string} message Failure message.
 */
function check(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${message}`);
  }
}

const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
check(manifest.name === '@darkmintis/dsh-device-fleet', 'package name is @darkmintis/dsh-device-fleet');
check(/^\d+\.\d+\.\d+$/u.test(String(manifest.version)), 'package version is semver');
check(manifest.license === 'MIT', 'license is MIT');
check(manifest.type === 'module', 'package is an ES module');
check(manifest.engines?.dsh !== undefined, 'engines.dsh is declared for the Harness version requirement');
check(manifest.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch points at cordis.patch.yml');
check(manifest.dsh?.client?.platform === 'web', 'dsh.client declares the web platform');
check(Array.isArray(manifest.files) && manifest.files.includes('index.js'), 'files list includes index.js');
check(Array.isArray(manifest.files) && manifest.files.includes('client.js'), 'files list includes client.js');
check(Array.isArray(manifest.files) && manifest.files.includes('cordis.patch.yml'), 'files list includes cordis.patch.yml');

const patch = await readFile(path.join(root, 'cordis.patch.yml'), 'utf8');
check(patch.includes('@darkmintis/dsh-device-fleet'), 'bundle patch names the package');
check(patch.includes('id: dsh-device-fleet'), 'bundle patch inserts the plugin row');

for (const file of ['index.js', 'lib/tools.js', 'lib/service.js', 'lib/adb.js', 'lib/render.js']) {
  check(await exists(file), `runtime file exists: ${file}`);
}
check(await exists('client.js'), 'web client half exists: client.js');
check(await exists('icon.svg'), 'display icon exists: icon.svg');

for (const locale of ['locale/en.json']) {
  const parsed = JSON.parse(await readFile(path.join(root, locale), 'utf8'));
  check(typeof parsed.meta?.title === 'string' && parsed.meta.title.length > 0, `${locale} declares meta.title`);
  check(typeof parsed.meta?.description === 'string' && parsed.meta.description.length > 0, `${locale} declares meta.description`);
}

/** Every module that ships to the Host runtime must import without throwing. */
const runtimeModules = [
  './lib/args.js',
  './lib/errors.js',
  './lib/parse.js',
  './lib/platform.js',
  './lib/adb.js',
  './lib/logcat.js',
  './lib/shell-policy.js',
  './lib/screenshot.js',
  './lib/render.js',
  './lib/service.js',
  './lib/tools.js',
  './index.js',
];
for (const module of runtimeModules) {
  try {
    await import(new URL(`../${module}`, import.meta.url));
    check(true, `imports cleanly: ${module}`);
  } catch (error) {
    check(false, `imports cleanly: ${module} (${error instanceof Error ? error.message : String(error)})`);
  }
}

if (failures > 0) {
  console.error(`build check failed with ${failures} problem(s)`);
  process.exit(1);
}
console.log('build ok');
