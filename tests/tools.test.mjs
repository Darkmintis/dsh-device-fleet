import assert from 'node:assert/strict';
import test from 'node:test';
import { TOOL_SPECS, registerApprovalGate, registerFleetTools } from '../lib/tools.js';

/**
 * Build a mock Cordis-like context that records registrations.
 *
 * @returns {{ ctx: any, tools: Map<string, any>, listeners: Array<{ event: string, handler: Function }> }} mock context state.
 */
function mockContext() {
  /** @type {Map<string, any>} */
  const tools = new Map();
  /** @type {Array<{ event: string, handler: Function }>} */
  const listeners = [];
  return {
    tools,
    listeners,
    ctx: {
      tools: {
        /** @param {any} definition Tool definition. */
        register(definition) {
          tools.set(definition.name, definition);
          return () => tools.delete(definition.name);
        },
      },
      /**
       * @param {string} event Event name.
       * @param {Function} handler Listener.
       */
      on(event, handler) {
        listeners.push({ event, handler });
        return () => {};
      },
      /** @param {Function} callback Effect body. */
      effect(callback) {
        const disposer = callback();
        return typeof disposer === 'function' ? disposer : () => {};
      },
    },
  };
}

/**
 * Build a fake fleet service that records calls.
 *
 * @param {{ throwOn?: string, result?: Record<string, unknown> }} [options] Behavior overrides.
 * @returns {{ service: any, calls: Array<{ method: string, args: unknown[] }> }} fake service and call log.
 */
function fakeService(options = {}) {
  /** @type {Array<{ method: string, args: unknown[] }>} */
  const calls = [];
  const service = new Proxy(
    {},
    {
      get(_target, property) {
        const method = String(property);
        return async (...args) => {
          calls.push({ method, args });
          if (options.throwOn === method) throw new Error('device exploded');
          return options.result ?? { ok: true, tool: method, method, ...(args[0] ?? {}) };
        };
      },
    },
  );
  return { service, calls };
}

test('registers every v1 tool with a precise description and strict schema', () => {
  const { ctx, tools } = mockContext();
  const { service } = fakeService();
  registerFleetTools(ctx, service);

  const expected = [
    'device_clear_data',
    'device_deep_link',
    'device_install',
    'device_launch',
    'device_logcat',
    'device_pull',
    'device_screenshot',
    'device_shell',
    'device_stop',
    'device_which',
    'emulator_start',
    'emulator_stop',
    'fleet_list',
  ];
  assert.deepEqual([...tools.keys()].sort(), expected);

  for (const spec of TOOL_SPECS) {
    const definition = tools.get(spec.name);
    assert.ok(definition !== undefined, spec.name);
    const words = definition.description.split(/\s+/u).filter(Boolean);
    assert.ok(words.length > 0 && words.length <= 16, `${spec.name} description is ${words.length} words`);
    assert.equal(definition.parameters.type, 'object');
    assert.equal(definition.parameters.additionalProperties, false);
    assert.equal(definition.output.schema.type, 'object');
    assert.equal(typeof definition.execute, 'function');
    assert.equal(typeof definition.output.render, 'function');
    const required = definition.parameters.required ?? [];
    for (const [name, argSpec] of Object.entries(spec.params)) {
      if (argSpec.required === true) assert.ok(required.includes(name), `${spec.name}.${name} must be required`);
      else assert.ok(!required.includes(name), `${spec.name}.${name} must not be required`);
    }
  }
});

test('device_logcat schema exposes the preset enum and bounded line count', () => {
  const { ctx, tools } = mockContext();
  registerFleetTools(ctx, fakeService().service);
  const parameters = tools.get('device_logcat').parameters;
  assert.deepEqual(parameters.properties.preset.enum, ['flutter', 'crash', 'upload', 'all']);
  assert.equal(parameters.properties.lines.minimum, 1);
  assert.equal(parameters.properties.lines.maximum, 2_000);
  assert.equal(parameters.properties.lines.default, 200);
});

test('execute rejects unknown arguments before calling the service', async () => {
  const { ctx, tools } = mockContext();
  const { service, calls } = fakeService();
  registerFleetTools(ctx, service);
  const result = await tools.get('device_launch').execute({ packageName: 'com.example.app', bogus: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_ARGUMENT');
  assert.equal(calls.length, 0);
});

test('execute rejects blank strings and missing required arguments', async () => {
  const { ctx, tools } = mockContext();
  const { calls } = fakeService();
  registerFleetTools(ctx, fakeService().service);
  const blank = await tools.get('device_launch').execute({ packageName: '   ' });
  assert.equal(blank.ok, false);
  assert.match(blank.error, /must not be blank/u);
  const missing = await tools.get('device_shell').execute({ command: 'pm list packages' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /missing required argument "serial"/u);
  assert.equal(calls.length, 0);
});

test('execute forwards validated arguments to the matching service method', async () => {
  const { ctx, tools } = mockContext();
  const { service, calls } = fakeService({ result: { ok: true, tool: 'device_launch', component: 'com.example.app/.MainActivity' } });
  registerFleetTools(ctx, service);
  const result = await tools.get('device_launch').execute({ packageName: 'com.example.app' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ method: 'launch', args: [{ packageName: 'com.example.app' }] }]);
});

test('execute converts thrown errors into the standard failure shape', async () => {
  const { ctx, tools } = mockContext();
  registerFleetTools(ctx, fakeService({ throwOn: 'launch' }).service);
  const result = await tools.get('device_launch').execute({ packageName: 'com.example.app' });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INTERNAL_ERROR');
  assert.match(result.error, /device_launch failed unexpectedly: device exploded/u);
  assert.equal(result.stack, undefined);
});

test('output render and presentationMeta expose the structured value', () => {
  const { ctx, tools } = mockContext();
  registerFleetTools(ctx, fakeService().service);
  const definition = tools.get('fleet_list');
  const value = { ok: true, tool: 'fleet_list', count: 1, total: 1, devices: [{ serial: 'R58M12345', state: 'device', model: 'SM_G973F' }] };
  const blocks = definition.output.render({}, value);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /R58M12345/u);
  assert.match(blocks[0].text, /SM_G973F/u);
  assert.deepEqual(definition.output.presentationMeta({}, value), value);
});

test('approval gate asks only for destructive tools and passes everything else through', async () => {
  const { ctx, listeners } = mockContext();
  registerApprovalGate(ctx);
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].event, 'tools/pre-execute');
  const handler = listeners[0].handler;

  /** @type {string[]} */
  const nextCalls = [];
  const next = async () => {
    nextCalls.push('next');
    return { kind: 'allow' };
  };

  for (const name of ['fleet_list', 'device_launch', 'device_screenshot', 'device_logcat', 'device_pull', 'write', 'bash']) {
    const decision = await handler({ name, arguments: {} }, next);
    assert.equal(decision.kind, 'allow', `${name} must not prompt`);
  }
  assert.equal(nextCalls.length, 7);

  const install = await handler({ name: 'device_install', arguments: { apkPath: 'C:/build/app-debug.apk', serial: 'R58M12345' } }, next);
  assert.equal(install.kind, 'ask');
  assert.match(install.reason, /app-debug\.apk/u);
  assert.match(install.reason, /R58M12345/u);
  assert.equal(install.displayReason.en, install.reason);

  const clear = await handler({ name: 'device_clear_data', arguments: { packageName: 'com.example.app' } }, next);
  assert.equal(clear.kind, 'ask');
  assert.match(clear.reason, /cannot be undone/u);

  const shell = await handler({ name: 'device_shell', arguments: { serial: 'emulator-5554', command: 'pm list packages' } }, next);
  assert.equal(shell.kind, 'ask');
  assert.match(shell.reason, /pm list packages/u);
  assert.match(shell.reason, /emulator-5554/u);
});
