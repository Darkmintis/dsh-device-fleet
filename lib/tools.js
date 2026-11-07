/**
 * Tool definitions and harness registration for the device fleet plugin.
 *
 * Each tool has a precise description, a validated JSON-schema argument map, a
 * structured output schema, and a render function. Read-only tools execute
 * without prompting; destructive tools are gated by the `tools/pre-execute`
 * waterfall in {@link registerApprovalGate}.
 *
 * @module
 */

import { parseArgs, requireNonBlank, toJsonSchema } from './args.js';
import { unexpectedFailure } from './errors.js';
import { renderResult } from './render.js';

/**
 * @typedef {import('./args.js').ArgMap} ArgMap
 * @typedef {ReturnType<typeof import('./service.js').createFleetService>} FleetService
 *
 * @typedef {object} ToolSpec
 * @property {string} name Wire tool name.
 * @property {string} description Precise model-facing description (at most 16 words).
 * @property {ArgMap} params Argument specifications.
 * @property {Record<string, unknown>} outputSchema Structured result schema.
 * @property {(service: FleetService, args: any) => Promise<Record<string, unknown>>} run Operation.
 */

/** Shared argument specs. */
const SERIAL_ARG = {
  type: /** @type {const} */ ('string'),
  description: 'Device serial from fleet_list; omit only when exactly one ready device is connected.',
};

const PACKAGE_ARG = {
  type: /** @type {const} */ ('string'),
  description: 'Application package name, for example com.example.app.',
};

/**
 * Build a loose output schema for one tool.
 *
 * @param {Record<string, Record<string, unknown>>} properties Payload properties, without `ok`/`tool`.
 * @returns {Record<string, unknown>} output schema.
 */
function outputSchema(properties) {
  return {
    type: 'object',
    properties: { ok: { type: 'boolean' }, tool: { type: 'string' }, ...properties },
    additionalProperties: true,
  };
}

/**
 * The complete v1 tool table.
 *
 * @type {ToolSpec[]}
 */
export const TOOL_SPECS = [
  {
    name: 'fleet_list',
    description: 'List Android devices and emulators with state, version, battery, and package version.',
    params: {
      serial: { ...SERIAL_ARG, description: 'Optional serial; limits the result to one device.' },
      packageName: { ...PACKAGE_ARG, description: 'Optional package whose versionName/versionCode should be reported per device.' },
    },
    outputSchema: outputSchema({
      adb: { type: 'object' },
      androidSdk: { type: 'string' },
      count: { type: 'number' },
      total: { type: 'number' },
      devices: { type: 'array' },
      unauthorized: { type: 'array' },
      offline: { type: 'array' },
    }),
    run: (service, args) => service.list(args),
  },
  {
    name: 'device_install',
    description: 'Install or replace an APK on one connected device.',
    params: {
      serial: SERIAL_ARG,
      apkPath: { type: 'string', required: true, description: 'Absolute path to the APK file to install. Relative paths resolve from the host process directory.' },
    },
    outputSchema: outputSchema({
      serial: { type: 'string' },
      apkPath: { type: 'string' },
      apkBytes: { type: 'number' },
      durationMs: { type: 'number' },
      output: { type: 'string' },
    }),
    run: (service, args) => service.install(args),
  },
  {
    name: 'device_launch',
    description: "Launch a package's launcher activity on one device.",
    params: {
      serial: SERIAL_ARG,
      packageName: { ...PACKAGE_ARG, required: true },
    },
    outputSchema: outputSchema({ serial: { type: 'string' }, packageName: { type: 'string' }, component: { type: 'string' } }),
    run: (service, args) => service.launch(args),
  },
  {
    name: 'device_stop',
    description: 'Force-stop an app on one connected device.',
    params: {
      serial: SERIAL_ARG,
      packageName: { ...PACKAGE_ARG, required: true },
    },
    outputSchema: outputSchema({ serial: { type: 'string' }, packageName: { type: 'string' } }),
    run: (service, args) => service.stop(args),
  },
  {
    name: 'device_clear_data',
    description: "Clear one app's data with pm clear.",
    params: {
      serial: SERIAL_ARG,
      packageName: { ...PACKAGE_ARG, required: true },
    },
    outputSchema: outputSchema({ serial: { type: 'string' }, packageName: { type: 'string' }, output: { type: 'string' } }),
    run: (service, args) => service.clearData(args),
  },
  {
    name: 'device_screenshot',
    description: 'Capture a device screenshot PNG and return its host path.',
    params: { serial: SERIAL_ARG },
    outputSchema: outputSchema({
      serial: { type: 'string' },
      path: { type: 'string' },
      bytes: { type: 'number' },
      width: { type: 'number' },
      height: { type: 'number' },
    }),
    run: (service, args) => service.screenshot(args),
  },
  {
    name: 'device_logcat',
    description: 'Read a bounded device logcat snapshot with presets and filter.',
    params: {
      serial: SERIAL_ARG,
      preset: {
        type: 'string',
        enum: ['flutter', 'crash', 'upload', 'all'],
        default: 'all',
        description: 'Preset filter: flutter exceptions, crash/ANR, upload flow, or all lines.',
      },
      filter: { type: 'string', description: 'Optional case-insensitive substring; only matching lines are returned.' },
      lines: { type: 'integer', min: 1, max: 2_000, default: 200, description: 'Maximum matching lines to return (1-2000).' },
    },
    outputSchema: outputSchema({
      serial: { type: 'string' },
      preset: { type: 'string' },
      presetLabel: { type: 'string' },
      filter: { type: 'string' },
      total: { type: 'number' },
      matched: { type: 'number' },
      lines: { type: 'array' },
      truncated: { type: 'boolean' },
    }),
    run: (service, args) => service.logcat(args),
  },
  {
    name: 'device_deep_link',
    description: 'Open a deep link URL on one connected device.',
    params: {
      serial: SERIAL_ARG,
      url: { type: 'string', required: true, description: 'Absolute URL with a scheme, for example https://example.com or myapp://route/42.' },
    },
    outputSchema: outputSchema({ serial: { type: 'string' }, url: { type: 'string' }, output: { type: 'string' } }),
    run: (service, args) => service.deepLink(args),
  },
  {
    name: 'device_shell',
    description: 'Run one allowlisted shell command on a device.',
    params: {
      serial: { ...SERIAL_ARG, required: true, description: 'Required device serial; select one device from fleet_list.' },
      command: {
        type: 'string',
        required: true,
        description: 'Plain command with an allowlisted first word: pm, am, dumpsys, settings, input, screencap, getprop, wm, svc, cmd, or ping. No shell metacharacters.',
      },
    },
    outputSchema: outputSchema({
      serial: { type: 'string' },
      command: { type: 'string' },
      exitCode: { type: 'number' },
      stdout: { type: 'string' },
      stderr: { type: 'string' },
    }),
    run: (service, args) => service.shell(args),
  },
  {
    name: 'device_pull',
    description: 'Copy a file from the device into a host temp directory.',
    params: {
      serial: SERIAL_ARG,
      remotePath: { type: 'string', required: true, description: 'Absolute device path, for example /sdcard/Download/photo.jpg.' },
    },
    outputSchema: outputSchema({ serial: { type: 'string' }, remotePath: { type: 'string' }, path: { type: 'string' }, bytes: { type: 'number' } }),
    run: (service, args) => service.pull(args),
  },
  {
    name: 'device_which',
    description: 'Show resolved adb, Android SDK, emulator, java, and flutter paths.',
    params: {},
    outputSchema: outputSchema({
      platform: { type: 'string' },
      adb: { type: 'object' },
      androidSdk: { type: 'object' },
      emulator: { type: 'object' },
      java: { type: 'object' },
      flutter: { type: 'object' },
    }),
    run: (service) => service.which(),
  },
  {
    name: 'emulator_start',
    description: 'Boot one Android AVD in the background.',
    params: {
      avdName: { type: 'string', required: true, description: 'AVD name exactly as emulator -list-avds prints it.' },
    },
    outputSchema: outputSchema({ avdName: { type: 'string' }, pid: { type: 'number' }, emulatorPath: { type: 'string' }, hint: { type: 'string' } }),
    run: (service, args) => service.emulatorStart(args),
  },
  {
    name: 'emulator_stop',
    description: 'Shut down one running Android emulator.',
    params: {
      serial: { ...SERIAL_ARG, required: true, description: 'Emulator serial to stop, for example emulator-5554.' },
    },
    outputSchema: outputSchema({ serial: { type: 'string' }, output: { type: 'string' } }),
    run: (service, args) => service.emulatorStop(args),
  },
];

/** Approval reasons keyed by destructive tool name. @type {Readonly<Record<string, (args: Record<string, unknown>) => string>>} */
const APPROVAL_REASONS = Object.freeze({
  device_install: (/** @type {Record<string, unknown>} */ args) =>
    `Install APK ${stringField(args.apkPath, 'the supplied APK')} on ${targetPhrase(args)}.`,
  device_clear_data: (/** @type {Record<string, unknown>} */ args) =>
    `Clear all app data for ${stringField(args.packageName, 'the app')} on ${targetPhrase(args)}. This cannot be undone.`,
  device_shell: (/** @type {Record<string, unknown>} */ args) =>
    `Run "${stringField(args.command, 'the supplied shell command')}" on ${targetPhrase(args, true)}.`,
});

/**
 * Register every fleet tool on the plugin context.
 *
 * @param {any} ctx Plugin context with `tools`.
 * @param {FleetService} service Fleet service implementation.
 * @returns {void}
 */
export function registerFleetTools(ctx, service) {
  for (const spec of TOOL_SPECS) {
    const parameters = toJsonSchema(spec.params);
    ctx.effect(() =>
      ctx.tools.register({
        name: spec.name,
        description: spec.description,
        parameters,
        output: {
          schema: spec.outputSchema,
          render: (/** @type {unknown} */ _args, /** @type {unknown} */ value) => renderResult(value),
          presentationMeta: (/** @type {unknown} */ _args, /** @type {unknown} */ value) => value,
        },
        async execute(/** @type {unknown} */ rawArgs) {
          const parsed = parseArgs(spec.name, spec.params, rawArgs);
          if (parsed.ok !== true) return parsed.failure;
          for (const key of Object.keys(parsed.args)) {
            const value = parsed.args[key];
            if (typeof value !== 'string') continue;
            const specEntry = spec.params[key];
            if (specEntry === undefined) continue;
            const blank = requireNonBlank(spec.name, key, value);
            if (blank !== undefined) return blank;
          }
          try {
            return await spec.run(service, parsed.args);
          } catch (error) {
            return unexpectedFailure(spec.name, error);
          }
        },
      }),
    );
  }
}

/**
 * Register the approval gate for destructive tools.
 *
 * Read-only tools fall through with `next()`; the three destructive tools return
 * `{kind: 'ask'}`, which the harness routes to its approval service.
 *
 * @param {any} ctx Plugin context.
 * @returns {void}
 */
export function registerApprovalGate(ctx) {
  ctx.on('tools/pre-execute', async (/** @type {any} */ exec, /** @type {() => Promise<any>} */ next) => {
    const reasonBuilder = APPROVAL_REASONS[exec.name];
    if (reasonBuilder === undefined) return next();
    const args = isRecord(exec.arguments) ? exec.arguments : {};
    const reason = reasonBuilder(args);
    return { kind: 'ask', reason, displayReason: { en: reason } };
  });
}

/**
 * Normalise the target part of an approval reason.
 *
 * @param {Record<string, unknown>} args Tool arguments.
 * @param {boolean} [requireExplicit] Whether a missing serial means "no target selected yet".
 * @returns {string} human-readable target.
 */
function targetPhrase(args, requireExplicit = false) {
  if (typeof args.serial === 'string' && args.serial !== '') return `device ${args.serial}`;
  return requireExplicit ? 'the selected device' : 'the single connected device';
}

/**
 * Read a string field for display.
 *
 * @param {unknown} value Candidate.
 * @param {string} fallback Fallback text.
 * @returns {string} display text.
 */
function stringField(value, fallback) {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

/**
 * Narrow a value to a plain object.
 *
 * @param {unknown} value Candidate.
 * @returns {value is Record<string, unknown>} true for plain objects.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
