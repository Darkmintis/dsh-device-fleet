/**
 * Contract tests for the `@darkmintis/dsh-device-fleet` Web client half.
 *
 * The suite loads `client.js` through a stubbed `window.__ModuleLoader__`, injects
 * a recording React shim, mounts the plugin against a fake Slot/locale context,
 * and renders every registered tool view for the `preparing`, `start`, `result`,
 * and malformed-block cases. It asserts:
 *
 * 1. exactly the 13 fleet wire tool names are registered into `tool.call.toolview`;
 * 2. one `en` + `zh` dictionary pair is registered with identical key sets;
 * 3. the plugin injects only the services it uses;
 * 4. no component throws for any phase or partial shape, and good fixtures render
 *    a non-empty tree;
 * 5. the key card facts (device state hints, screenshot path, bounded logcat tail,
 *    approval chip on destructive tools) actually reach the output.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const FLEET_TOOLS = [
  'fleet_list',
  'device_install',
  'device_launch',
  'device_stop',
  'device_clear_data',
  'device_screenshot',
  'device_logcat',
  'device_deep_link',
  'device_shell',
  'device_pull',
  'device_which',
  'emulator_start',
  'emulator_stop',
];

const DESTRUCTIVE = new Set(['device_install', 'device_clear_data', 'device_shell']);

/** Arguments keyed by tool, mirroring the Host tool schemas. */
const ARGS = {
  fleet_list: { packageName: 'com.example.app' },
  device_install: { serial: 'emulator-5554', apkPath: 'C:\\builds\\app-release.apk' },
  device_launch: { serial: 'emulator-5554', packageName: 'com.example.app' },
  device_stop: { serial: 'emulator-5554', packageName: 'com.example.app' },
  device_clear_data: { serial: 'emulator-5554', packageName: 'com.example.app' },
  device_screenshot: { serial: 'emulator-5554' },
  device_logcat: { serial: 'emulator-5554', preset: 'flutter', filter: 'Exception', lines: 200 },
  device_deep_link: { serial: 'emulator-5554', url: 'myapp://route/42' },
  device_shell: { serial: 'emulator-5554', command: 'getprop ro.build.version.release' },
  device_pull: { serial: 'emulator-5554', remotePath: '/sdcard/Download/photo.jpg' },
  device_which: {},
  emulator_start: { avdName: 'Pixel_7_API_34' },
  emulator_stop: { serial: 'emulator-5554' },
};

/** Structured success envelopes, exactly as `output.presentationMeta` persists them. */
const PAYLOADS = {
  fleet_list: {
    ok: true,
    tool: 'fleet_list',
    adb: { path: 'C:\\Android\\platform-tools\\adb.exe', source: 'ANDROID_HOME', version: '1.0.41' },
    androidSdk: 'C:\\Android\\Sdk',
    count: 1,
    total: 2,
    devices: [
      {
        serial: 'emulator-5554',
        state: 'device',
        model: 'sdk_gphone64_x86_64',
        manufacturer: 'Google',
        device: 'emu64xa',
        androidVersion: '14',
        sdk: 34,
        batteryPct: 87.4,
        screenOn: true,
        isEmulator: true,
        adbPath: 'C:\\Android\\platform-tools\\adb.exe',
        package: { name: 'com.example.app', versionName: '1.2.3', versionCode: 1203 },
      },
      {
        serial: 'R58M12ABC',
        state: 'unauthorized',
        model: 'SM-G991B',
        manufacturer: 'Samsung',
        androidVersion: '13',
        sdk: 33,
        isEmulator: false,
      },
    ],
    unauthorized: [{ serial: 'R58M12ABC', model: 'SM-G991B', hint: 'Accept the USB debugging prompt on the device.' }],
    offline: [],
    warnings: [],
  },
  device_install: {
    ok: true,
    tool: 'device_install',
    serial: 'emulator-5554',
    model: 'sdk_gphone64_x86_64',
    apkPath: 'C:\\builds\\app-release.apk',
    apkBytes: 12345678,
    durationMs: 4210,
    output: 'Success',
  },
  device_launch: {
    ok: true,
    tool: 'device_launch',
    serial: 'emulator-5554',
    packageName: 'com.example.app',
    component: 'com.example.app/.MainActivity',
    output: 'Starting: Intent',
  },
  device_stop: { ok: true, tool: 'device_stop', serial: 'emulator-5554', packageName: 'com.example.app' },
  device_clear_data: { ok: true, tool: 'device_clear_data', serial: 'emulator-5554', packageName: 'com.example.app', output: 'Success' },
  device_screenshot: {
    ok: true,
    tool: 'device_screenshot',
    serial: 'emulator-5554',
    path: 'C:\\Users\\dev\\AppData\\Local\\Temp\\dsh-fleet\\shot-1.png',
    bytes: 245760,
    width: 1080,
    height: 2400,
    cleaned: false,
  },
  device_logcat: {
    ok: true,
    tool: 'device_logcat',
    serial: 'emulator-5554',
    preset: 'flutter',
    presetLabel: 'Flutter exceptions',
    filter: 'Exception',
    total: 500,
    matched: 120,
    lines: Array.from({ length: 50 }, (_, index) => `08-01 10:00:${String(index).padStart(2, '0')} E/flutter: boom ${index}`),
    truncated: true,
    hint: 'Reproduce the flow first for more signal.',
  },
  device_deep_link: { ok: true, tool: 'device_deep_link', serial: 'emulator-5554', url: 'myapp://route/42', output: 'Starting: Intent' },
  device_shell: {
    ok: true,
    tool: 'device_shell',
    serial: 'emulator-5554',
    command: 'getprop ro.build.version.release',
    argv: ['getprop', 'ro.build.version.release'],
    exitCode: 0,
    stdout: '14\n',
    stderr: '',
  },
  device_pull: {
    ok: true,
    tool: 'device_pull',
    serial: 'emulator-5554',
    remotePath: '/sdcard/Download/photo.jpg',
    path: 'C:\\Temp\\photo.jpg',
    bytes: 4096,
  },
  device_which: {
    ok: true,
    tool: 'device_which',
    platform: 'win32',
    adb: { found: true, path: 'C:\\Android\\platform-tools\\adb.exe', source: 'PATH', version: '1.0.41' },
    androidSdk: { found: true, path: 'C:\\Android\\Sdk' },
    emulator: { found: true, path: 'C:\\Android\\Sdk\\emulator\\emulator.exe' },
    java: { found: false, hint: 'Install a JDK.' },
    flutter: { found: false, hint: 'Install Flutter.' },
  },
  emulator_start: {
    ok: true,
    tool: 'emulator_start',
    avdName: 'Pixel_7_API_34',
    pid: 12345,
    emulatorPath: 'C:\\Android\\Sdk\\emulator\\emulator.exe',
    hint: 'First boot takes ~30 s.',
  },
  emulator_stop: { ok: true, tool: 'emulator_stop', serial: 'emulator-5554', output: 'OK' },
};

const FAILURE_PAYLOAD = {
  ok: false,
  code: 'ADB_FAILED',
  error: 'adb devices failed: no devices',
  hint: 'Run device_which and check adb in a terminal.',
  details: { stderr: 'adb server not running' },
};

// ---------------------------------------------------------------------------
// Fake module table + React shim
// ---------------------------------------------------------------------------

/**
 * Flatten nested child arrays.
 * @param {any[]} children createElement child arguments.
 * @returns {any[]} flat children.
 */
function flatten(children) {
  const out = [];
  for (const child of children) {
    if (Array.isArray(child)) out.push(...flatten(child));
    else out.push(child);
  }
  return out;
}

/**
 * Minimal React recorder: elements are plain objects; hooks return stable data.
 * @returns {Record<string, any>} React shim.
 */
function createFakeReact() {
  let nextId = 0;
  return {
    createElement(type, props, ...children) {
      return { id: nextId++, type, props: props ?? {}, children: flatten(children) };
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}];
    },
    useMemo(factory) {
      return factory();
    },
    useCallback(callback) {
      return callback;
    },
    memo(component) {
      return component;
    },
  };
}

/**
 * Load `client.js` through a stub loader and materialize its factory.
 * @returns {Promise<{ module: { inject: string[], apply: Function }, registrations: any[] }>} loaded module.
 */
async function loadClientModule() {
  let registration;
  const originalWindow = globalThis.window;
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) {
        registration = entry;
      },
    },
  };
  try {
    await import('../client.js');
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
  assert.ok(registration, 'client.js must register a lazy module-table entry');
  assert.equal(registration.id, '@darkmintis/dsh-device-fleet', 'loader id is the package name');
  assert.equal(typeof registration.factory, 'function', 'loader entry exposes a factory');

  const React = createFakeReact();
  const requiredSpecifiers = [];
  const loaded = registration.factory((specifier) => {
    requiredSpecifiers.push(specifier);
    if (specifier !== 'react') throw new Error(`unexpected require("${specifier}") in the client half`);
    return React;
  });
  assert.deepEqual(requiredSpecifiers, ['react'], 'the client half requires only react');
  assert.deepEqual(loaded.inject, ['slots', 'locale'], 'the client half injects only the used services');
  assert.equal(typeof loaded.apply, 'function');
  return loaded;
}

/**
 * Mount the plugin against a recording context.
 * @param {{ apply: Function }} module Loaded client module.
 * @returns {{ registrations: any[], locales: any[], effects: string[] }} recorded effects.
 */
function mount(module) {
  const registrations = [];
  const locales = [];
  const effects = [];
  const ctx = {
    locale: {
      register(namespace, dictionaries) {
        locales.push({ namespace, dictionaries });
        return () => {};
      },
    },
    effect(effect, label) {
      effects.push(label);
      const dispose = effect();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    slots: {
      inject(key, callback) {
        assert.equal(key, 'tool.call.toolview', 'everything registers into tool.call.toolview');
        const result = callback();
        assert.ok(Array.isArray(result), 'the inject callback returns an iterable of disposers');
        assert.equal(result.length, FLEET_TOOLS.length, 'one disposer per registration');
        return () => {};
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
  module.apply(ctx);
  return { registrations, locales, effects };
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/**
 * Lazy argument reader used by the preparing/start stages.
 * @param {string} tool Tool name.
 * @returns {Record<string, any>} reader.
 */
function readerFor(tool) {
  const args = ARGS[tool] ?? {};
  return {
    text(key) {
      return typeof args[key] === 'string' ? args[key] : undefined;
    },
    complete(key) {
      return Object.hasOwn(args, key);
    },
  };
}

/**
 * Preparing phase block.
 * @param {string} tool Tool name.
 * @returns {Record<string, any>} block.
 */
function preparingBlock(tool) {
  return { callId: 'call-1', phase: 'preparing', name: tool, args: readerFor(tool) };
}

/**
 * Started (dispatched) phase block.
 * @param {string} tool Tool name.
 * @returns {Record<string, any>} block.
 */
function startBlock(tool) {
  return {
    callId: 'call-1',
    phase: 'start',
    name: tool,
    argsRaw: JSON.stringify(ARGS[tool] ?? {}),
    args: readerFor(tool),
    subCalls: [],
  };
}

/**
 * Settled result block.
 * @param {string} tool Tool name.
 * @param {Record<string, any>} value Result envelope.
 * @param {{ meta?: any, text?: string, isError?: boolean, error?: any }} [options] Overrides.
 * @returns {Record<string, any>} block.
 */
function resultBlock(tool, value, options = {}) {
  const hasMeta = Object.hasOwn(options, 'meta');
  return {
    kind: 'tool-call-result',
    callId: 'call-1',
    call: { name: tool, argsRaw: JSON.stringify(ARGS[tool] ?? {}) },
    content: [{ type: 'text', text: options.text ?? JSON.stringify(value) }],
    meta: hasMeta ? options.meta : value,
    isError: options.isError === true,
    ...(options.error === undefined ? {} : { error: options.error }),
    subCalls: [],
  };
}

/**
 * Expand function components so text inside nested components is observable.
 * @param {any} node Element, string, array, or null.
 * @returns {any} expanded tree.
 */
function expand(node) {
  if (node === null || node === undefined) return null;
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node !== 'object') return node;
  if (typeof node.type === 'function') return expand(node.type(node.props));
  if (Array.isArray(node.children)) return { ...node, children: node.children.map(expand) };
  return node;
}

/**
 * Collect every string rendered below an expanded tree.
 * @param {any} node Expanded tree.
 * @param {string[]} [out] Accumulator.
 * @returns {string[]} rendered strings.
 */
function collectText(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (typeof node === 'object' && Array.isArray(node.children)) {
    for (const child of node.children) collectText(child, out);
  }
  return out;
}

/**
 * Render one component and return its expanded tree plus joined text.
 * @param {Function} component Registered component.
 * @param {Record<string, any>} props Owner props.
 * @returns {{ tree: any, text: string }} render result.
 */
function renderComponent(component, props) {
  const tree = component(props);
  const expanded = expand(tree);
  return { tree: expanded, text: collectText(expanded).join(' ').replace(/\s+/gu, ' ') };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const module = await loadClientModule();
const { registrations, locales, effects } = mount(module);
const byKey = new Map(registrations.map((entry) => [entry.options.key, entry]));

test('registers exactly the 13 fleet wire tool names', () => {
  assert.equal(registrations.length, 13, 'one registration per fleet tool');
  const keys = registrations.map((entry) => entry.options.key).sort();
  assert.deepEqual(keys, [...FLEET_TOOLS].sort(), 'registered keys are exactly the fleet tool names');
  for (const entry of registrations) {
    assert.equal(entry.options.name, 'tool.call.toolview', 'slot name is tool.call.toolview');
    assert.equal(entry.options.locale, 'device-fleet', 'slot locale namespace is device-fleet');
    assert.equal(typeof entry.component, 'function', 'registration maps to a component');
  }
});

test('registers complete en and zh dictionaries', () => {
  assert.equal(locales.length, 1, 'one dictionary registration');
  const [{ namespace, dictionaries }] = locales;
  assert.equal(namespace, 'device-fleet');
  assert.ok(dictionaries.en, 'en dictionary present');
  assert.ok(dictionaries.zh, 'zh dictionary present');
  const enKeys = Object.keys(dictionaries.en).sort();
  const zhKeys = Object.keys(dictionaries.zh).sort();
  assert.deepEqual(zhKeys, enKeys, 'zh mirrors the en key set');
  assert.ok(enKeys.includes('tool.fleet_list'), 'tool labels are localized');
  assert.ok(enKeys.includes('common.approvalGated'), 'approval wording is localized');
  for (const key of enKeys) {
    assert.equal(typeof dictionaries.en[key], 'string', `en.${key} is a string`);
    assert.equal(typeof dictionaries.zh[key], 'string', `zh.${key} is a string`);
  }
  assert.ok(
    effects.some((label) => String(label).includes('device-fleet: dictionaries')),
    'dictionary registration runs through ctx.effect for cleanup',
  );
});

test('every tool renders preparing and start placeholders without throwing', () => {
  for (const tool of FLEET_TOOLS) {
    const component = byKey.get(tool).component;
    const preparing = renderComponent(component, { toolName: tool, phase: 'preparing', block: preparingBlock(tool), t: undefined });
    assert.ok(preparing.tree !== null, `${tool} preparing renders a tree`);
    assert.ok(preparing.text.length > 0, `${tool} preparing renders text`);
    assert.match(preparing.text, /Preparing/u, `${tool} preparing names its stage`);

    const started = renderComponent(component, { toolName: tool, phase: 'start', block: startBlock(tool), t: undefined });
    assert.ok(started.tree !== null, `${tool} start renders a tree`);
    assert.match(started.text, /Running/u, `${tool} start names its stage`);
  }
});

test('every tool renders a settled success without throwing', () => {
  /** Custom cards carry their own status surfaces (devices, log tail). */
  const NO_STATUS_CHIP = new Set(['fleet_list', 'device_logcat']);
  for (const tool of FLEET_TOOLS) {
    const component = byKey.get(tool).component;
    const rendered = renderComponent(component, {
      toolName: tool,
      phase: 'result',
      block: resultBlock(tool, PAYLOADS[tool]),
      t: undefined,
    });
    assert.ok(rendered.tree !== null, `${tool} result renders a tree`);
    assert.ok(rendered.text.length > 0, `${tool} result renders text`);
    if (!NO_STATUS_CHIP.has(tool)) {
      assert.match(rendered.text, /Done/u, `${tool} result reports completion`);
    }
  }
});

test('fleet_list renders the adb header, device cards, and unauthorized hint', () => {
  const component = byKey.get('fleet_list').component;
  const { text } = renderComponent(component, {
    toolName: 'fleet_list',
    phase: 'result',
    block: resultBlock('fleet_list', PAYLOADS.fleet_list),
    t: undefined,
  });
  assert.match(text, /C:\\Android\\platform-tools\\adb\.exe/u, 'adb path is shown');
  assert.match(text, /emulator-5554/u, 'device serial is shown');
  assert.match(text, /Google sdk_gphone64_x86_64/u, 'manufacturer and model are shown');
  assert.match(text, /Android 14/u, 'Android version is shown');
  assert.match(text, /SDK 34/u, 'SDK level is shown');
  assert.match(text, /87% battery/u, 'battery percentage is shown');
  assert.match(text, /screen on/u, 'screen state is shown');
  assert.match(text, /emulator/u, 'emulator badge is shown');
  assert.match(text, /1\.2\.3/u, 'package versionName is shown');
  assert.match(text, /R58M12ABC/u, 'unauthorized device serial is shown');
  assert.match(text, /Allow USB debugging/u, 'unauthorized device gets the tap-Allow hint');
});

test('device_screenshot renders the saved path, dimensions, and read_image hint', () => {
  const component = byKey.get('device_screenshot').component;
  const { text } = renderComponent(component, {
    toolName: 'device_screenshot',
    phase: 'result',
    block: resultBlock('device_screenshot', PAYLOADS.device_screenshot),
    t: undefined,
  });
  assert.match(text, /shot-1\.png/u, 'saved path is shown');
  assert.match(text, /1080×2400/u, 'dimensions are shown');
  assert.match(text, /240 KB/u, 'size is shown in KB');
  assert.match(text, /read_image/u, 'the read_image hint is shown');
});

test('device_logcat renders a bounded tail and the preset/count header', () => {
  const component = byKey.get('device_logcat').component;
  const { text } = renderComponent(component, {
    toolName: 'device_logcat',
    phase: 'result',
    block: resultBlock('device_logcat', PAYLOADS.device_logcat),
    t: undefined,
  });
  assert.match(text, /Flutter exceptions/u, 'preset label is shown');
  assert.match(text, /120\/500 matched/u, 'matched/total counts are shown');
  assert.match(text, /boom 49/u, 'the tail is shown');
  assert.doesNotMatch(text, /boom 0(?:\s|$)/u, 'the collapsed prefix is not rendered');
  assert.match(text, /older matches dropped/u, 'truncation is disclosed');
  assert.match(text, /Show more/u, 'long logs are collapsible');
});

test('destructive tools show a lock chip that never claims approval happened', () => {
  for (const tool of FLEET_TOOLS) {
    const component = byKey.get(tool).component;
    const { text } = renderComponent(component, {
      toolName: tool,
      phase: 'result',
      block: resultBlock(tool, PAYLOADS[tool]),
      t: undefined,
    });
    if (DESTRUCTIVE.has(tool)) {
      assert.match(text, /Approval required/u, `${tool} shows the approval chip`);
      assert.doesNotMatch(text, /approved/iu, `${tool} does not imply approval happened`);
    } else {
      assert.doesNotMatch(text, /Approval required/u, `${tool} is not marked approval-gated`);
    }
  }
});

test('compact rows surface the key argument and result facts', () => {
  const install = renderComponent(byKey.get('device_install').component, {
    toolName: 'device_install',
    phase: 'result',
    block: resultBlock('device_install', PAYLOADS.device_install),
    t: undefined,
  });
  assert.match(install.text, /app-release\.apk/u, 'install shows the APK path');
  assert.match(install.text, /12 MB|12056 KB|12057 KB/u, 'install shows the APK size');

  const shell = renderComponent(byKey.get('device_shell').component, {
    toolName: 'device_shell',
    phase: 'result',
    block: resultBlock('device_shell', PAYLOADS.device_shell),
    t: undefined,
  });
  assert.match(shell.text, /getprop ro\.build\.version\.release/u, 'shell shows the command');
  assert.match(shell.text, /exit 0/u, 'shell shows the exit code');

  const which = renderComponent(byKey.get('device_which').component, {
    toolName: 'device_which',
    phase: 'result',
    block: resultBlock('device_which', PAYLOADS.device_which),
    t: undefined,
  });
  assert.match(which.text, /win32/u, 'device_which shows the platform');
  assert.match(which.text, /platform-tools\\adb\.exe/u, 'device_which shows the adb path');
});

test('failure envelopes render the error, hint, and failed status', () => {
  const fleet = renderComponent(byKey.get('fleet_list').component, {
    toolName: 'fleet_list',
    phase: 'result',
    block: resultBlock('fleet_list', FAILURE_PAYLOAD),
    t: undefined,
  });
  assert.match(fleet.text, /adb devices failed/u, 'failure message is shown');
  assert.match(fleet.text, /ADB_FAILED/u, 'failure code is shown');
  assert.match(fleet.text, /Run device_which/u, 'failure hint is shown');
  assert.match(fleet.text, /Failed/u, 'failure status is shown');

  const shell = renderComponent(byKey.get('device_shell').component, {
    toolName: 'device_shell',
    phase: 'result',
    block: resultBlock('device_shell', FAILURE_PAYLOAD),
    t: undefined,
  });
  assert.match(shell.text, /adb devices failed/u, 'compact failure message is shown');
  assert.match(shell.text, /Failed/u, 'compact failure status is shown');
});

test('result text is parsed when the block has no structured meta', () => {
  const fromJson = renderComponent(byKey.get('fleet_list').component, {
    toolName: 'fleet_list',
    phase: 'result',
    block: resultBlock('fleet_list', PAYLOADS.fleet_list, { meta: undefined }),
    t: undefined,
  });
  assert.match(fromJson.text, /1\.2\.3/u, 'JSON text fallback recovers the payload');

  const fromErrorText = renderComponent(byKey.get('fleet_list').component, {
    toolName: 'fleet_list',
    phase: 'result',
    block: resultBlock('fleet_list', FAILURE_PAYLOAD, {
      meta: null,
      text: 'Error [ADB_NOT_FOUND]: adb not found\nHint: Install platform-tools.',
    }),
    t: undefined,
  });
  assert.match(fromErrorText.text, /adb not found/u, 'rendered Error text fallback is used');
  assert.match(fromErrorText.text, /Failed/u, 'rendered Error text marks the card failed');
});

test('rich cards render no row when a settled result carries nothing usable', () => {
  for (const tool of ['fleet_list', 'device_screenshot', 'device_logcat']) {
    const component = byKey.get(tool).component;
    const rendering = component({
      toolName: tool,
      phase: 'result',
      block: { kind: 'tool-call-result', callId: 'call-1', content: [], meta: null, isError: false },
      t: undefined,
    });
    assert.equal(expand(rendering), null, `${tool} renders nothing usable as null`);
  }
});

test('no component throws for malformed phases and partial blocks', () => {
  const malformed = [
    undefined,
    null,
    {},
    { block: undefined, phase: 'result' },
    { kind: 'tool-call-result', callId: 'call-1', isError: false },
    { kind: 'tool-call-result', callId: 'call-1', meta: 42, content: 'not-an-array', isError: false },
    { kind: 'tool-call-result', callId: 'call-1', meta: { unexpected: true }, content: [{ type: 'text', text: 'plain text, not JSON' }], isError: false },
    { kind: 'tool-call-result', callId: 'call-1', meta: null, content: [], isError: true, error: { name: 'ToolError', code: 'TOOL_ERROR' } },
    { phase: 'start', name: 'fleet_list', argsRaw: '{not json', args: null },
    { phase: 'preparing', name: 'device_shell', args: undefined },
  ];
  for (const tool of FLEET_TOOLS) {
    const component = byKey.get(tool).component;
    for (const block of malformed) {
      for (const phase of ['preparing', 'start', 'result', undefined]) {
        assert.doesNotThrow(() => {
          expand(component({ toolName: tool, phase, block, t: undefined }));
        }, `${tool} must not throw for block ${JSON.stringify(block)} at phase ${String(phase)}`);
      }
    }
  }
});

test('components tolerate a missing translator', () => {
  const rendered = renderComponent(byKey.get('device_launch').component, {
    toolName: 'device_launch',
    phase: 'result',
    block: resultBlock('device_launch', PAYLOADS.device_launch),
    t: undefined,
  });
  assert.match(rendered.text, /Launch app/u, 'English fallback label is used');
});
