import assert from 'node:assert/strict';
import test from 'node:test';
import { ALLOWED_SHELL_COMMANDS, validateShellCommand } from '../lib/shell-policy.js';

test('allows every documented command', () => {
  for (const command of ALLOWED_SHELL_COMMANDS) {
    const result = validateShellCommand(`${command} --help`);
    assert.equal(result.ok, true, `expected ${command} to be allowed`);
    assert.deepEqual(result.argv, [command, '--help']);
  }
});

test('accepts realistic inspection commands', () => {
  for (const command of [
    'pm list packages',
    'am start -a android.intent.action.VIEW -d https://example.com',
    'dumpsys battery',
    'settings get global airplane_mode_on',
    'input text hello',
    'getprop ro.build.version.release',
    'wm size',
    'svc data enable',
    'cmd package resolve-activity --brief com.example.app',
    'ping -c 1 8.8.8.8',
  ]) {
    assert.equal(validateShellCommand(command).ok, true, command);
  }
});

test('rejects commands outside the allowlist with a clear reason', () => {
  for (const command of ['reboot', 'rm -rf /sdcard', 'su 0 id', 'logcat -d', 'ls /sdcard', 'cat /proc/cpuinfo']) {
    const result = validateShellCommand(command);
    assert.equal(result.ok, false, command);
    assert.equal(result.failure.code, 'SHELL_COMMAND_BLOCKED');
    assert.match(result.failure.hint, /Allowed commands: pm, am, dumpsys/u);
  }
});

test('rejects shell metacharacters before the allowlist decision', () => {
  for (const command of [
    'pm list packages; reboot',
    'pm list packages | grep example',
    'pm list packages && id',
    'pm list packages > /sdcard/out.txt',
    'pm list packages `id`',
    '`reboot`',
    'pm list packages $(id)',
    'pm list packages\nreboot',
    'pm "list" packages',
    'pm list packages *',
    'pm list packages \\x',
  ]) {
    const result = validateShellCommand(command);
    assert.equal(result.ok, false, command);
    assert.equal(result.failure.code, 'SHELL_METACHARACTER', command);
  }
});

test('rejects empty, blank, non-string, and oversized commands', () => {
  assert.equal(validateShellCommand('').failure.code, 'SHELL_COMMAND_BLOCKED');
  assert.equal(validateShellCommand('   ').failure.code, 'SHELL_COMMAND_BLOCKED');
  assert.equal(validateShellCommand(/** @type {any} */ (42)).failure.code, 'SHELL_COMMAND_BLOCKED');
  assert.equal(validateShellCommand(`pm ${'x'.repeat(600)}`).failure.code, 'SHELL_COMMAND_BLOCKED');
});
