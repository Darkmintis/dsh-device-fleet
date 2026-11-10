/**
 * Stable result envelope shared by every device-fleet tool.
 *
 * Every tool returns either a success object (`{ ok: true, tool, ...payload }`)
 * or a failure object (`{ ok: false, code, error, hint?, details? }`). The
 * human-readable content block is produced by `lib/render.js`; tool handlers
 * never throw raw errors at the model.
 *
 * @module
 */

/** Machine-readable failure codes. Keep these stable; they are part of the tool contract. */
export const ErrorCodes = Object.freeze({
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  ADB_NOT_FOUND: 'ADB_NOT_FOUND',
  ADB_FAILED: 'ADB_FAILED',
  ADB_TIMEOUT: 'ADB_TIMEOUT',
  NO_DEVICES: 'NO_DEVICES',
  SERIAL_REQUIRED: 'SERIAL_REQUIRED',
  SERIAL_NOT_FOUND: 'SERIAL_NOT_FOUND',
  DEVICE_OFFLINE: 'DEVICE_OFFLINE',
  DEVICE_UNAUTHORIZED: 'DEVICE_UNAUTHORIZED',
  APK_NOT_FOUND: 'APK_NOT_FOUND',
  APK_INVALID: 'APK_INVALID',
  PACKAGE_NOT_FOUND: 'PACKAGE_NOT_FOUND',
  SHELL_COMMAND_BLOCKED: 'SHELL_COMMAND_BLOCKED',
  SHELL_METACHARACTER: 'SHELL_METACHARACTER',
  SHELL_COMMAND_FAILED: 'SHELL_COMMAND_FAILED',
  SCREENSHOT_FAILED: 'SCREENSHOT_FAILED',
  PULL_FAILED: 'PULL_FAILED',
  INSTALL_FAILED: 'INSTALL_FAILED',
  EMULATOR_NOT_FOUND: 'EMULATOR_NOT_FOUND',
  SCRCPY_NOT_FOUND: 'SCRCPY_NOT_FOUND',
  SCRCPY_FAILED: 'SCRCPY_FAILED',
  EMULATOR_FAILED: 'EMULATOR_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

/**
 * Build the standard failure object.
 *
 * @param {string} code One of {@link ErrorCodes}.
 * @param {string} error Human-readable, actionable error message.
 * @param {string} [hint] Suggested next action for the model or user.
 * @param {unknown} [details] Optional structured context (device lists, command output, ...).
 * @returns {{ ok: false, code: string, error: string, hint?: string, details?: unknown }} failure envelope.
 */
export function failure(code, error, hint, details) {
  /** @type {{ ok: false, code: string, error: string, hint?: string, details?: unknown }} */
  const result = { ok: false, code, error };
  if (hint !== undefined) result.hint = hint;
  if (details !== undefined) result.details = details;
  return result;
}

/**
 * Build the standard success object.
 *
 * @param {string} tool Wire tool name.
 * @param {Record<string, unknown>} [payload] Tool-specific result fields.
 * @returns {{ ok: true, tool: string } & Record<string, unknown>} success envelope.
 */
export function success(tool, payload = {}) {
  return { ok: true, tool, ...payload };
}

/**
 * Convert an unexpected thrown value into the standard failure object without
 * leaking a stack trace into the model-visible result.
 *
 * @param {string} tool Wire tool name.
 * @param {unknown} error The caught value.
 * @returns {{ ok: false, code: string, error: string, hint?: string }} failure envelope.
 */
export function unexpectedFailure(tool, error) {
  const message = error instanceof Error ? error.message : String(error);
  return failure(
    ErrorCodes.INTERNAL_ERROR,
    `${tool} failed unexpectedly: ${message}`,
    'Retry the command. If it keeps failing, run device_which and check that adb works in a terminal.',
  );
}

/**
 * Whether a value is a fleet failure envelope.
 *
 * @param {unknown} value Candidate value.
 * @returns {boolean} true for the standard failure shape.
 */
export function isFailure(value) {
  return typeof value === 'object' && value !== null && /** @type {{ ok?: unknown }} */ (value).ok === false;
}
