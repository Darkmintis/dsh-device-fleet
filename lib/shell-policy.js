/**
 * Command allowlist for `device_shell`.
 *
 * v1 deliberately exposes a tiny allowlist of inspection and automation
 * commands (`pm`, `am`, `dumpsys`, ...). Everything else is rejected with a
 * reason. Because adb serialises argv into the device shell as a single string,
 * the command is also rejected when it contains shell metacharacters, quotes,
 * globbing, or redirections, so arguments can never splice in a second command.
 *
 * @module
 */

import { ErrorCodes, failure } from './errors.js';

/** Commands the model may run through `device_shell` in v1. */
export const ALLOWED_SHELL_COMMANDS = Object.freeze([
  'pm',
  'am',
  'dumpsys',
  'settings',
  'input',
  'screencap',
  'getprop',
  'wm',
  'svc',
  'cmd',
  'ping',
]);

const ALLOWED = new Set(ALLOWED_SHELL_COMMANDS);

/**
 * Characters accepted in a shell command. Everything outside this set — `;`,
 * `|`, `&`, `>`, `<`, backticks, `$`, quotes, parentheses, braces, wildcards,
 * backslashes, and newlines — is rejected.
 */
const SAFE_COMMAND = /^[A-Za-z0-9 ._/:,+@=-]+$/u;

/** Upper bound on a single command; generous for `dumpsys` flags, hostile beyond. */
const MAX_COMMAND_LENGTH = 512;

/**
 * @typedef {object} ShellPolicyResult
 * @property {true} ok Policy accepted the command.
 * @property {string[]} argv Split argv (without the leading `shell`).
 * @property {string} command Base command used.
 *
 * @typedef {object} ShellPolicyFailure
 * @property {false} ok Rejection.
 * @property {ReturnType<typeof failure>} failure Standard failure object.
 */

/**
 * Validate a `device_shell` command string against the allowlist.
 *
 * @param {string} command Command text, for example `pm list packages`.
 * @returns {ShellPolicyResult | ShellPolicyFailure} accepted argv or a failure.
 */
export function validateShellCommand(command) {
  if (typeof command !== 'string') {
    return reject('command must be a string', 'Pass a command string such as "pm list packages".');
  }
  const trimmed = command.trim();
  if (trimmed === '') {
    return reject('command must not be empty', 'Pass a command such as "pm list packages".');
  }
  if (trimmed.length > MAX_COMMAND_LENGTH) {
    return reject(
      `command is longer than ${MAX_COMMAND_LENGTH} characters`,
      'Shorten the command; device_shell is meant for small inspections.',
    );
  }
  if (!SAFE_COMMAND.test(trimmed)) {
    return reject(
      'command contains shell metacharacters, quotes, globbing, or redirection',
      'device_shell accepts a plain argv-style command only; remove ; | & > < ` $ \' " ( ) { } * ? \\ and newlines.',
      ErrorCodes.SHELL_METACHARACTER,
    );
  }
  const argv = trimmed.split(/\s+/u);
  const base = argv[0];
  if (!ALLOWED.has(base)) {
    return reject(
      `command "${base}" is not allowlisted for device_shell`,
      `Allowed commands: ${ALLOWED_SHELL_COMMANDS.join(', ')}. Use the dedicated fleet tools for install, launch, screenshots, and logcat.`,
      ErrorCodes.SHELL_COMMAND_BLOCKED,
    );
  }
  return { ok: true, argv, command: base };
}

/**
 * Build a documented rejection.
 *
 * @param {string} message Human-readable reason.
 * @param {string} hint Suggested alternative.
 * @param {string} [code] Failure code.
 * @returns {ShellPolicyFailure} failure envelope wrapped for the policy result.
 */
function reject(message, hint, code = ErrorCodes.SHELL_COMMAND_BLOCKED) {
  return { ok: false, failure: failure(code, message, hint) };
}
