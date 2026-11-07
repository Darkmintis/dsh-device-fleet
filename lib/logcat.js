/**
 * Bounded logcat presets and filtering.
 *
 * `device_logcat` is a snapshot, never a stream: the device log is read with
 * `logcat -d -t <cap>`, filtered in memory, and only the requested tail is
 * returned. Presets are generic Android/Flutter/upload-flow patterns; the
 * plugin has no application-specific dependency.
 *
 * @module
 */

/** Maximum lines fetched from the device before filtering. */
export const FETCH_LINE_CAP = 4000;

/** @typedef {'flutter' | 'crash' | 'upload' | 'all'} LogcatPreset */

/**
 * @typedef {object} PresetDefinition
 * @property {string} label Human label for the preset.
 * @property {readonly RegExp[]} patterns Patterns that select a line; empty means "everything".
 * @property {string} hint Short guidance for the model.
 */

/** @type {Readonly<Record<LogcatPreset, PresetDefinition>>} */
export const LOGCAT_PRESETS = Object.freeze({
  flutter: {
    label: 'Flutter exceptions',
    patterns: [/E\/flutter\b/u, /FATAL EXCEPTION/u, /Unhandled Exception/u, /flutter.*(?:exception|error)/iu],
    hint: 'Flutter runtime errors and unhandled exceptions.',
  },
  crash: {
    label: 'Crashes and ANRs',
    patterns: [/FATAL EXCEPTION/u, /\bANR in\b/u, /am_crash/u, /beginning of crash/u, /\bFATAL\b/u],
    hint: 'Fatal exceptions, ANRs, and activity-manager crash records.',
  },
  upload: {
    label: 'Upload flow',
    patterns: [/upload/iu],
    hint: 'Lines mentioning upload; combine with filter to narrow to failures.',
  },
  all: {
    label: 'All log lines',
    patterns: [],
    hint: 'Unfiltered tail; combine with filter to search for a substring.',
  },
});

/**
 * @typedef {object} LogcatSelection
 * @property {string} preset Preset key.
 * @property {string} presetLabel Human label.
 * @property {string | undefined} filter Applied substring filter.
 * @property {number} total Lines fetched from the device.
 * @property {number} matched Lines matching the preset and filter before truncation.
 * @property {string[]} lines Returned tail.
 * @property {boolean} truncated Whether older matching lines were dropped.
 */

/**
 * Filter a captured log snapshot.
 *
 * @param {string[]} lines Raw log lines in device order (oldest first).
 * @param {{ preset?: LogcatPreset, filter?: string, limit?: number }} [options] Selection options.
 * @returns {LogcatSelection} bounded matching tail.
 */
export function selectLogcatLines(lines, options = {}) {
  const presetKey = options.preset ?? 'all';
  const definition = LOGCAT_PRESETS[presetKey] ?? LOGCAT_PRESETS.all;
  const filter = typeof options.filter === 'string' && options.filter !== '' ? options.filter.toLowerCase() : undefined;
  const limit = clampInt(options.limit ?? 200, 1, FETCH_LINE_CAP);
  /** @type {string[]} */
  const matched = [];
  for (const line of lines) {
    if (definition.patterns.length > 0 && !definition.patterns.some((pattern) => pattern.test(line))) continue;
    if (filter !== undefined && !line.toLowerCase().includes(filter)) continue;
    matched.push(line);
  }
  const truncated = matched.length > limit;
  return {
    preset: presetKey,
    presetLabel: definition.label,
    filter: options.filter === '' ? undefined : options.filter,
    total: lines.length,
    matched: matched.length,
    lines: truncated ? matched.slice(matched.length - limit) : matched,
    truncated,
  };
}

/**
 * Clamp an integer into an inclusive range.
 *
 * @param {number} value Input value.
 * @param {number} min Inclusive minimum.
 * @param {number} max Inclusive maximum.
 * @returns {number} Clamped integer.
 */
export function clampInt(value, min, max) {
  const integer = Math.trunc(Number(value));
  if (!Number.isFinite(integer)) return min;
  return Math.min(max, Math.max(min, integer));
}

/**
 * Split a raw logcat dump into lines without trailing carriage returns.
 *
 * @param {string} output Raw `logcat -d` output.
 * @returns {string[]} Non-empty trimmed line endings, device order preserved.
 */
export function splitLogLines(output) {
  return String(output)
    .split(/\r?\n/u)
    .map((line) => line.replace(/\r$/u, ''))
    .filter((line) => line !== '');
}
