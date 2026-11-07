/**
 * Lossless-JSON normalisation for tool results.
 *
 * The harness validates that a tool's returned value round-trips through JSON
 * without losing information; `undefined` properties, `NaN`, and `Infinity`
 * therefore have to be removed before a result is returned. This helper keeps
 * every meaningful field and drops only non-JSON artifacts.
 *
 * @module
 */

/**
 * Normalise an arbitrary value into lossless JSON.
 *
 * - object properties whose value is `undefined` are omitted;
 * - array holes and `undefined` entries become `null`;
 * - `NaN` and infinities become `null`;
 * - functions, symbols, and bigints are omitted/nullified because they cannot
 *   round-trip through JSON.
 *
 * @param {unknown} value Any tool result value.
 * @returns {any} JSON-safe value.
 */
export function lossless(value) {
  if (value === null) return null;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') return Number.isFinite(/** @type {number} */ (value)) ? value : null;
  if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') return null;
  if (Array.isArray(value)) return value.map((entry) => lossless(entry));
  if (type === 'object') {
    /** @type {Record<string, any>} */
    const result = {};
    for (const [key, entry] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
      if (entry === undefined) continue;
      if (typeof entry === 'function' || typeof entry === 'symbol' || typeof entry === 'bigint') continue;
      result[key] = lossless(entry);
    }
    return result;
  }
  return null;
}
