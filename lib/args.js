/**
 * Typed argument validation and JSON-schema projection for fleet tools.
 *
 * The harness forwards model-supplied JSON without validating it, so every tool
 * validates its own arguments: unknown properties are rejected, required
 * properties must be present, and types, enums, and bounds are enforced before
 * any adb command runs.
 *
 * @module
 */

import { ErrorCodes, failure } from './errors.js';

/**
 * @typedef {'string' | 'integer' | 'number' | 'boolean' | 'stringArray'} ArgType
 *
 * @typedef {object} ArgSpec
 * @property {ArgType} type Value type.
 * @property {string} description Model-facing description; state defaults and validation here.
 * @property {boolean} [required] Whether the property is required.
 * @property {'required' | 'optional'} [presence] Alternative spelling of `required`.
 * @property {readonly (string | number)[]} [enum] Allowed values.
 * @property {number} [min] Inclusive numeric minimum.
 * @property {number} [max] Inclusive numeric maximum.
 * @property {unknown} [default] Value applied when the property is omitted.
 *
 * @typedef {Record<string, ArgSpec>} ArgMap
 *
 * @typedef {Record<string, unknown>} ParsedArgs
 */

/**
 * Project an argument map onto the JSON schema the harness exposes to the model.
 *
 * @param {ArgMap} params Argument specifications.
 * @returns {Record<string, unknown>} JSON-schema-like tool parameter object.
 */
export function toJsonSchema(params) {
  /** @type {Record<string, unknown>} */
  const properties = {};
  /** @type {string[]} */
  const required = [];
  for (const [name, spec] of Object.entries(params)) {
    /** @type {Record<string, unknown>} */
    const property = { type: spec.type === 'stringArray' ? 'array' : spec.type, description: spec.description };
    if (spec.type === 'stringArray') property.items = { type: 'string' };
    if (spec.enum !== undefined) property.enum = [...spec.enum];
    if (spec.min !== undefined) property.minimum = spec.min;
    if (spec.max !== undefined) property.maximum = spec.max;
    if (spec.default !== undefined) property.default = spec.default;
    properties[name] = property;
    if (isRequired(spec)) required.push(name);
  }
  /** @type {Record<string, unknown>} */
  const schema = { type: 'object', properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
}

/**
 * @param {ArgSpec} spec Argument specification.
 * @returns {boolean} true when the property must be supplied.
 */
function isRequired(spec) {
  return spec.required === true || spec.presence === 'required';
}

/**
 * Validate model-supplied arguments against a tool's argument map.
 *
 * @param {string} tool Wire tool name (for error text).
 * @param {ArgMap} params Argument specifications.
 * @param {unknown} input Raw arguments forwarded by the harness.
 * @returns {{ ok: true, args: ParsedArgs } | { ok: false, failure: ReturnType<typeof failure> }} parsed value or failure.
 */
export function parseArgs(tool, params, input) {
  /**
   * @param {string} message Validation message.
   * @param {string} [hint] Suggested fix.
   * @returns {{ ok: false, failure: ReturnType<typeof failure> }} failure result.
   */
  const invalid = (message, hint) => ({
    ok: /** @type {const} */ (false),
    failure: failure(ErrorCodes.INVALID_ARGUMENT, `${tool}: ${message}`, hint),
  });

  if (input === undefined || input === null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    return invalid('arguments must be a JSON object', `Pass a JSON object with these properties: ${Object.keys(params).join(', ') || '(none)'}.`);
  }

  const provided = /** @type {Record<string, unknown>} */ (input);
  const unknownKeys = Object.keys(provided).filter((key) => !(key in params));
  if (unknownKeys.length > 0) {
    return invalid(
      `unknown argument${unknownKeys.length === 1 ? '' : 's'}: ${unknownKeys.join(', ')}`,
      `Allowed arguments: ${Object.keys(params).join(', ') || '(none)'}.`,
    );
  }

  /** @type {ParsedArgs} */
  const args = {};
  for (const [name, spec] of Object.entries(params)) {
    const raw = provided[name];
    if (raw === undefined) {
      if (isRequired(spec)) {
        return invalid(`missing required argument "${name}"`, spec.description);
      }
      if (spec.default !== undefined) args[name] = spec.default;
      continue;
    }
    const checked = validateValue(name, spec, raw);
    if (checked !== undefined) return invalid(checked, spec.description);
    args[name] = raw;
  }
  return { ok: /** @type {const} */ (true), args };
}

/**
 * Validate one value; returns an explanatory message or undefined when valid.
 *
 * @param {string} name Property name.
 * @param {ArgSpec} spec Argument specification.
 * @param {unknown} raw Supplied value.
 * @returns {string | undefined} validation message.
 */
function validateValue(name, spec, raw) {
  switch (spec.type) {
    case 'string': {
      if (typeof raw !== 'string') return `argument "${name}" must be a string`;
      if (spec.enum !== undefined && !spec.enum.includes(raw)) {
        return `argument "${name}" must be one of: ${spec.enum.join(', ')}`;
      }
      return undefined;
    }
    case 'stringArray': {
      if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
        return `argument "${name}" must be an array of strings`;
      }
      return undefined;
    }
    case 'integer':
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return `argument "${name}" must be a number`;
      if (spec.type === 'integer' && !Number.isInteger(raw)) return `argument "${name}" must be an integer`;
      if (spec.min !== undefined && raw < spec.min) return `argument "${name}" must be >= ${spec.min}`;
      if (spec.max !== undefined && raw > spec.max) return `argument "${name}" must be <= ${spec.max}`;
      return undefined;
    }
    case 'boolean': {
      if (typeof raw !== 'boolean') return `argument "${name}" must be a boolean`;
      return undefined;
    }
    default:
      return `argument "${name}" has an unsupported schema type`;
  }
}

/**
 * Reject empty or whitespace-only strings with a specific message.
 *
 * @param {string} tool Wire tool name.
 * @param {string} name Argument name.
 * @param {string} value Supplied value.
 * @returns {ReturnType<typeof failure> | undefined} failure when blank.
 */
export function requireNonBlank(tool, name, value) {
  if (value.trim() === '') {
    return failure(ErrorCodes.INVALID_ARGUMENT, `${tool}: argument "${name}" must not be blank`, `Pass a non-empty ${name}.`);
  }
  return undefined;
}
