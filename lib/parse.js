/**
 * Pure parsers for adb and Android command output.
 *
 * Every parser accepts raw text or bytes and returns plain data; none of them
 * touch the filesystem or spawn processes, which keeps them directly testable
 * against captured real-device output.
 *
 * @module
 */

/**
 * @typedef {object} AdbDevice
 * @property {string} serial Stable adb serial, for example `R58M12345` or `emulator-5554`.
 * @property {'device' | 'offline' | 'unauthorized' | 'bootloader' | 'recovery' | 'unknown'} state Connection state.
 * @property {string} [model] `model:` qualifier from `adb devices -l` (underscores become spaces).
 * @property {string} [product] `product:` qualifier.
 * @property {string} [device] `device:` qualifier.
 * @property {string} [transportId] `transport_id:` qualifier.
 * @property {string} [usb] `usb:` qualifier (bus/port path).
 * @property {string} [note] Free-form note for unusual rows such as `no permissions`.
 */

/** Device states reported by `adb devices -l` that mean "connected and usable". */
const READY_STATES = new Set(['device']);

/**
 * Parse `adb devices -l` output.
 *
 * @param {string} output Raw command output.
 * @returns {{ devices: AdbDevice[], warnings: string[] }} Parsed devices and advisory lines.
 */
export function parseDeviceList(output) {
  /** @type {AdbDevice[]} */
  const devices = [];
  /** @type {string[]} */
  const warnings = [];
  for (const rawLine of String(output).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (/^List of devices attached$/i.test(line)) continue;
    if (/^\* daemon .*(started|not running)/i.test(line)) {
      warnings.push(line);
      continue;
    }
    if (/^adb server/i.test(line)) {
      warnings.push(line);
      continue;
    }
    const tokens = line.split(/\s+/);
    const [serial, stateToken] = tokens;
    if (serial === undefined || stateToken === undefined) {
      warnings.push(line);
      continue;
    }
    /** @type {AdbDevice} */
    const device = { serial, state: normalizeState(stateToken) };
    const qualifiers = tokens.slice(2);
    let note;
    for (const qualifier of qualifiers) {
      const separator = qualifier.indexOf(':');
      if (separator === -1) {
        note = note === undefined ? qualifier : `${note} ${qualifier}`;
        continue;
      }
      const key = qualifier.slice(0, separator);
      const value = qualifier.slice(separator + 1);
      switch (key) {
        case 'model':
          device.model = value.replace(/_/g, ' ');
          break;
        case 'product':
          device.product = value;
          break;
        case 'device':
          device.device = value;
          break;
        case 'transport_id':
          device.transportId = value;
          break;
        case 'usb':
          device.usb = value;
          break;
        default:
          break;
      }
    }
    if (note !== undefined) device.note = note;
    devices.push(device);
  }
  return { devices, warnings };
}

/**
 * Map a raw state token from `adb devices` onto the documented states.
 *
 * @param {string} token Raw state token.
 * @returns {AdbDevice['state']} Normalised state.
 */
export function normalizeState(token) {
  switch (token) {
    case 'device':
      return 'device';
    case 'offline':
      return 'offline';
    case 'unauthorized':
      return 'unauthorized';
    case 'bootloader':
    case 'recovery':
    case 'sideload':
    case 'rescue':
      return /** @type {AdbDevice['state']} */ (token);
    default:
      return 'unknown';
  }
}

/**
 * Whether a parsed device is connected and responsive.
 *
 * @param {AdbDevice | undefined} device Parsed device.
 * @returns {boolean} true when the device accepts commands.
 */
export function isReady(device) {
  return device !== undefined && READY_STATES.has(device.state);
}

/**
 * Whether a parsed device is an emulator. `emulator-*` serials are decisive;
 * `ro.kernel.qemu` and emulator-style models are the fallback signal.
 *
 * @param {AdbDevice | undefined} device Parsed device.
 * @param {Record<string, string>} [props] Parsed `getprop` map.
 * @returns {boolean} true for emulators.
 */
export function isEmulator(device, props) {
  if (device === undefined) return false;
  if (device.serial.startsWith('emulator-')) return true;
  if (props !== undefined) {
    if (props['ro.kernel.qemu'] === '1') return true;
    const model = props['ro.product.model'] ?? '';
    if (/sdk_gphone|google_sdk|Android SDK built for|emulator/i.test(model)) return true;
  }
  return false;
}

/**
 * Parse the full `getprop` map.
 *
 * @param {string} output Raw `getprop` output.
 * @returns {Record<string, string>} Property name to value.
 */
export function parseProps(output) {
  /** @type {Record<string, string>} */
  const props = {};
  for (const line of String(output).split(/\r?\n/)) {
    const match = /^\[([^\]]+)\]:\s*\[(.*)\]$/u.exec(line.trim());
    if (match !== null) props[match[1]] = match[2];
  }
  return props;
}

/**
 * Parse the battery level percentage from `dumpsys battery`.
 *
 * @param {string} output Raw command output.
 * @returns {number | undefined} Battery percentage 0-100.
 */
export function parseBatteryLevel(output) {
  const match = /^\s*level:\s*(\d{1,3})\s*$/imu.exec(String(output));
  if (match === null) return undefined;
  const level = Number(match[1]);
  return Number.isFinite(level) && level >= 0 && level <= 100 ? level : undefined;
}

/**
 * Parse the screen on/off state from `dumpsys power`.
 *
 * @param {string} output Raw command output.
 * @returns {boolean | undefined} true when the screen is interactive.
 */
export function parseScreenAwake(output) {
  const text = String(output);
  const wakefulness = /mWakefulness=(\w+)/u.exec(text);
  if (wakefulness !== null) {
    const value = wakefulness[1].toLowerCase();
    if (value === 'awake') return true;
    if (value === 'asleep' || value === 'dozing' || value === 'dreaming') return false;
  }
  const screenOn = /mScreenOn=(\w+)|mScreenOnFully=(\w+)|"mScreenOn"=(\w+)/u.exec(text);
  if (screenOn !== null) {
    const value = (screenOn[1] ?? screenOn[2] ?? screenOn[3] ?? '').toLowerCase();
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  const displayPower = /Display Power:\s*state=(\w+)/u.exec(text);
  if (displayPower !== null) return displayPower[1] === 'ON';
  return undefined;
}

/**
 * Parse one package's version from `dumpsys package <package>` output.
 *
 * @param {string} output Raw command output.
 * @param {string} packageName Exact package name.
 * @returns {{ versionName?: string, versionCode?: string } | undefined} Version fields when the package is installed.
 */
export function parsePackageVersion(output, packageName) {
  const text = String(output);
  const marker = `Package [${packageName}]`;
  const start = text.indexOf(marker);
  if (start === -1) return undefined;
  const remainder = text.slice(start + marker.length);
  const nextPackage = remainder.search(/\n\s*Package \[/u);
  const section = nextPackage === -1 ? remainder : remainder.slice(0, nextPackage);
  /** @type {{ versionName?: string, versionCode?: string }} */
  const version = {};
  const versionName = /^\s*versionName=(\S+)/mu.exec(section);
  if (versionName !== null) version.versionName = versionName[1];
  const versionCode = /^\s*versionCode=(\d+)/mu.exec(section);
  if (versionCode !== null) version.versionCode = versionCode[1];
  return Object.keys(version).length === 0 ? undefined : version;
}

/**
 * Parse the launchable component from `cmd package resolve-activity --brief`.
 *
 * @param {string} output Raw command output.
 * @returns {string | undefined} `package/activity` component.
 */
export function parseResolvedComponent(output) {
  const lines = String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (/^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/u.test(line)) return line;
  }
  return undefined;
}

/**
 * Read the PNG dimensions from an image buffer's IHDR chunk.
 *
 * @param {Buffer | undefined} bytes PNG bytes.
 * @returns {{ width: number, height: number } | undefined} Image dimensions when the buffer is a PNG.
 */
export function parsePngSize(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24) return undefined;
  const signature = '89504e470d0a1a0a';
  if (bytes.subarray(0, 8).toString('hex') !== signature) return undefined;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0) return undefined;
  return { width, height };
}

/**
 * Parse `emulator -list-avds` output.
 *
 * @param {string} output Raw command output.
 * @returns {string[]} AVD names in file order.
 */
export function parseAvdList(output) {
  return String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !/^INFO\s*\|/u.test(line));
}

/**
 * Whether `adb install` output reports success.
 *
 * @param {string} output Combined stdout/stderr.
 * @returns {boolean} true when the install succeeded.
 */
export function installSucceeded(output) {
  return /(^|\n)\s*Success\s*($|\n)/u.test(String(output)) || /Performing Streamed Install[\s\S]*Success/u.test(String(output));
}

/**
 * Whether `pm clear` output reports success.
 *
 * @param {string} output Combined stdout/stderr.
 * @returns {boolean} true when app data was cleared.
 */
export function clearSucceeded(output) {
  return /(^|\n)\s*Success\s*($|\n)/u.test(String(output));
}

/**
 * Turn an adb serial into a filesystem-safe fragment.
 *
 * @param {string} serial Device serial.
 * @returns {string} Sanitised serial.
 */
export function serialForFilename(serial) {
  return serial.replace(/[^A-Za-z0-9._-]+/gu, '_');
}
