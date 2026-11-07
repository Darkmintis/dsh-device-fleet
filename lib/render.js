/**
 * Human-readable rendering of fleet tool results.
 *
 * The same JSON value returned by `execute` is rendered here as a compact text
 * block for the model. Failures include the code, the actionable message, and
 * the hint; successes render as tables or short summaries.
 *
 * @module
 */

/**
 * Render any fleet tool value as content blocks.
 *
 * @param {unknown} value Success or failure envelope.
 * @returns {Array<{ type: 'text', text: string }>} one text content block.
 */
export function renderResult(value) {
  const text = renderText(value);
  return [{ type: 'text', text }];
}

/**
 * Render one value to text.
 *
 * @param {unknown} value Tool result value.
 * @returns {string} model-facing text.
 */
export function renderText(value) {
  if (!isRecord(value)) return String(value);
  if (value.ok === false) return renderFailure(value);
  const tool = typeof value.tool === 'string' ? value.tool : undefined;
  switch (tool) {
    case 'fleet_list':
      return renderFleetList(value);
    case 'device_logcat':
      return renderLogcat(value);
    case 'device_screenshot':
      return renderScreenshot(value);
    case 'device_which':
      return renderWhich(value);
    default:
      return renderGeneric(tool, value);
  }
}

/**
 * Render the standard failure envelope.
 *
 * @param {Record<string, unknown>} value Failure envelope.
 * @returns {string} failure text.
 */
function renderFailure(value) {
  const code = typeof value.code === 'string' ? value.code : 'ERROR';
  const message = typeof value.error === 'string' ? value.error : 'The operation failed.';
  const lines = [`Error [${code}]: ${message}`];
  if (typeof value.hint === 'string' && value.hint !== '') lines.push(`Hint: ${value.hint}`);
  if (value.details !== undefined) {
    const details = safeJson(value.details, 1_200);
    if (details !== '') lines.push(`Details: ${details}`);
  }
  return lines.join('\n');
}

/**
 * Render `fleet_list`.
 *
 * @param {Record<string, unknown>} value Success envelope.
 * @returns {string} device table.
 */
function renderFleetList(value) {
  const lines = [];
  const adb = isRecord(value.adb) ? value.adb : {};
  const adbPath = typeof adb.path === 'string' ? adb.path : 'unknown';
  const adbVersion = typeof adb.version === 'string' ? ` v${adb.version}` : '';
  lines.push(`adb: ${adbPath}${adbVersion}`);
  if (typeof value.androidSdk === 'string') lines.push(`Android SDK: ${value.androidSdk}`);
  lines.push(`Devices: ${String(value.count ?? 0)} ready / ${String(value.total ?? 0)} connected`);
  const devices = Array.isArray(value.devices) ? value.devices : [];
  if (devices.length === 0) {
    lines.push('');
    lines.push('No ready devices. Connect a phone with USB debugging or boot an emulator, then retry.');
  } else {
    lines.push('');
    lines.push(...deviceTable(devices));
  }
  const unauthorized = Array.isArray(value.unauthorized) ? value.unauthorized : [];
  if (unauthorized.length > 0) {
    lines.push('');
    lines.push('Action needed:');
    for (const entry of unauthorized) {
      if (!isRecord(entry)) continue;
      const serial = typeof entry.serial === 'string' ? entry.serial : 'unknown';
      const hint = typeof entry.hint === 'string' ? entry.hint : 'Accept the USB debugging prompt on the device.';
      lines.push(`- ${serial}: ${hint}`);
    }
  }
  const offline = Array.isArray(value.offline) ? value.offline : [];
  if (offline.length > 0) {
    lines.push('');
    lines.push(`Offline: ${offline.map((entry) => (isRecord(entry) && typeof entry.serial === 'string' ? entry.serial : String(entry))).join(', ')}`);
  }
  return lines.join('\n');
}

/**
 * Format devices as a fixed-width table.
 *
 * @param {unknown[]} devices Raw device rows.
 * @returns {string[]} header and body lines.
 */
function deviceTable(devices) {
  const header = ['SERIAL', 'STATE', 'MODEL', 'ANDROID', 'SDK', 'BAT', 'SCREEN', 'TYPE', 'PKG'];
  /** @type {string[][]} */
  const rows = devices.map((raw) => {
    const device = isRecord(raw) ? raw : {};
    const pkg = isRecord(device.package) ? device.package : undefined;
    const pkgText = pkg === undefined ? '' : `${pkg.versionName ?? '?'} (${pkg.versionCode ?? '?'})`;
    return [
      text(device.serial),
      text(device.state),
      text(device.model),
      text(device.androidVersion),
      text(device.sdk),
      typeof device.batteryPct === 'number' ? `${Math.round(device.batteryPct)}%` : '-',
      device.screenOn === true ? 'on' : device.screenOn === false ? 'off' : '-',
      device.isEmulator === true ? 'emulator' : 'phone',
      pkgText,
    ];
  });
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map((row) => (row[index] ?? '').length)));
  /**
   * @param {string[]} row Table row.
   * @returns {string} formatted row.
   */
  const format = (row) => row.map((cell, index) => (index === row.length - 1 ? cell : pad(cell, widths[index] ?? 0))).join('  ').trimEnd();
  return [format(header), format(header.map((title) => '-'.repeat(title.length))), ...rows.map(format)];
}

/**
 * Render `device_logcat`.
 *
 * @param {Record<string, unknown>} value Success envelope.
 * @returns {string} log header plus tail.
 */
function renderLogcat(value) {
  const serial = text(value.serial);
  const preset = text(value.preset);
  const filter = typeof value.filter === 'string' && value.filter !== '' ? ` filter="${value.filter}"` : '';
  const matched = typeof value.matched === 'number' ? value.matched : 0;
  const total = typeof value.total === 'number' ? value.total : 0;
  const lines = Array.isArray(value.lines) ? value.lines.map((line) => String(line)) : [];
  const header = `logcat ${serial} · preset=${preset}${filter} · ${matched}/${total} lines matched${
    value.truncated === true ? ' (older matches dropped)' : ''
  }`;
  if (lines.length === 0) {
    const hint = typeof value.hint === 'string' ? value.hint : 'No log lines matched.';
    return `${header}\nNo matching lines. ${hint} Try preset=all with a filter, or reproduce the flow first.`;
  }
  return [header, ...lines].join('\n');
}

/**
 * Render `device_screenshot`.
 *
 * @param {Record<string, unknown>} value Success envelope.
 * @returns {string} screenshot summary.
 */
function renderScreenshot(value) {
  const lines = [`Screenshot saved: ${text(value.path)}`];
  const facts = [];
  if (typeof value.serial === 'string') facts.push(value.serial);
  if (typeof value.width === 'number' && typeof value.height === 'number') facts.push(`${value.width}x${value.height}`);
  if (typeof value.bytes === 'number') facts.push(`${Math.round(value.bytes / 1024)} KB`);
  if (facts.length > 0) lines.push(facts.join(' · '));
  lines.push('Read it with the read_image tool using that absolute path.');
  return lines.join('\n');
}

/**
 * Render `device_which`.
 *
 * @param {Record<string, unknown>} value Success envelope.
 * @returns {string} resolved tool paths.
 */
function renderWhich(value) {
  const lines = [`Platform: ${text(value.platform)}`];
  for (const name of ['adb', 'androidSdk', 'emulator', 'java', 'flutter']) {
    const entry = isRecord(value[name]) ? value[name] : undefined;
    if (entry === undefined) continue;
    if (entry.found === true) {
      const version = typeof entry.version === 'string' ? ` v${entry.version}` : '';
      const source = typeof entry.source === 'string' ? ` (${entry.source})` : '';
      lines.push(`${name}: ${text(entry.path)}${source}${version}`);
    } else {
      lines.push(`${name}: not found — ${text(entry.hint)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Render a generic tool result as a short key/value summary.
 *
 * @param {string | undefined} tool Wire tool name.
 * @param {Record<string, unknown>} value Success envelope.
 * @returns {string} summary text.
 */
function renderGeneric(tool, value) {
  const lines = [];
  const headline = GENERIC_HEADLINES[tool ?? ''] ?? (tool === undefined ? 'Done.' : `${tool}: done.`);
  lines.push(headline);
  const facts = [];
  if (typeof value.serial === 'string') facts.push(value.serial);
  if (typeof value.packageName === 'string') facts.push(value.packageName);
  if (typeof value.component === 'string') facts.push(value.component);
  if (typeof value.durationMs === 'number') facts.push(`${value.durationMs} ms`);
  if (typeof value.bytes === 'number') facts.push(`${Math.round(value.bytes / 1024)} KB`);
  if (typeof value.path === 'string') facts.push(value.path);
  if (typeof value.pid === 'number') facts.push(`pid ${value.pid}`);
  if (typeof value.exitCode === 'number') facts.push(`exit ${value.exitCode}`);
  if (facts.length > 0) lines.push(facts.join(' · '));
  if (typeof value.hint === 'string' && value.hint !== '' && tool !== 'device_logcat') lines.push(value.hint);
  for (const field of ['stdout', 'stderr', 'output']) {
    if (typeof value[field] === 'string' && value[field] !== '') {
      lines.push(`${field}:`, String(value[field]).trim());
    }
  }
  return lines.join('\n');
}

/** Headlines for tools rendered as summaries. @type {Record<string, string>} */
const GENERIC_HEADLINES = Object.freeze({
  device_install: 'APK installed.',
  device_launch: 'App launched.',
  device_stop: 'App force-stopped.',
  device_clear_data: 'App data cleared.',
  device_deep_link: 'Deep link dispatched.',
  device_shell: 'Shell command completed.',
  device_pull: 'File pulled from device.',
  emulator_start: 'Emulator boot started.',
  emulator_stop: 'Emulator stopped.',
});

/**
 * Pad a cell to a width.
 *
 * @param {string} value Cell text.
 * @param {number} width Target width.
 * @returns {string} padded cell.
 */
function pad(value, width) {
  return value + ' '.repeat(Math.max(0, width - value.length));
}

/**
 * Stringify a scalar or nested value compactly.
 *
 * @param {unknown} value Any value.
 * @returns {string} display string.
 */
function text(value) {
  if (value === undefined || value === null) return '-';
  if (typeof value === 'string') return value === '' ? '-' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return safeJson(value, 400);
}

/**
 * JSON-stringify a value without throwing.
 *
 * @param {unknown} value Any value.
 * @param {number} max Maximum characters.
 * @returns {string} compact JSON or empty string.
 */
function safeJson(value, max) {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return '';
    return json.length <= max ? json : `${json.slice(0, max)}…`;
  } catch {
    return '';
  }
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
