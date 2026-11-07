import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArgs, requireNonBlank, toJsonSchema } from '../lib/args.js';

const params = {
  serial: { type: 'string', description: 'Device serial.' },
  lines: { type: 'integer', min: 1, max: 10, default: 3, description: 'Line count.' },
  preset: { type: 'string', enum: ['all', 'crash'], default: 'all', description: 'Preset.' },
  packageName: { type: 'string', required: true, description: 'Package.' },
};

test('toJsonSchema projects types, enums, bounds, defaults, and required', () => {
  const schema = toJsonSchema(params);
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['packageName']);
  assert.deepEqual(schema.properties.preset.enum, ['all', 'crash']);
  assert.equal(schema.properties.lines.minimum, 1);
  assert.equal(schema.properties.lines.maximum, 10);
  assert.equal(schema.properties.lines.default, 3);
});

test('parseArgs applies defaults and accepts valid input', () => {
  const parsed = parseArgs('demo', params, { packageName: 'com.example.app' });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.args, { packageName: 'com.example.app', lines: 3, preset: 'all' });
});

test('parseArgs rejects unknown arguments with the allowed list', () => {
  const parsed = parseArgs('demo', params, { packageName: 'com.example.app', bogus: 1 });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.failure.code, 'INVALID_ARGUMENT');
  assert.match(parsed.failure.error, /unknown argument: bogus/u);
  assert.match(parsed.failure.hint, /serial, lines, preset, packageName/u);
});

test('parseArgs rejects missing required arguments', () => {
  const parsed = parseArgs('demo', params, {});
  assert.equal(parsed.ok, false);
  assert.match(parsed.failure.error, /missing required argument "packageName"/u);
});

test('parseArgs rejects wrong types, enums, and bounds', () => {
  assert.equal(parseArgs('demo', params, { packageName: 7 }).ok, false);
  assert.equal(parseArgs('demo', params, { packageName: 'x', lines: 0 }).ok, false);
  assert.equal(parseArgs('demo', params, { packageName: 'x', lines: 11 }).ok, false);
  assert.equal(parseArgs('demo', params, { packageName: 'x', lines: 1.5 }).ok, false);
  assert.equal(parseArgs('demo', params, { packageName: 'x', preset: 'upload' }).ok, false);
  assert.match(parseArgs('demo', params, { packageName: 'x', preset: 'upload' }).failure.error, /must be one of/u);
});

test('parseArgs rejects non-object input', () => {
  const parsed = parseArgs('demo', params, ['com.example.app']);
  assert.equal(parsed.ok, false);
  assert.match(parsed.failure.error, /must be a JSON object/u);
});

test('requireNonBlank catches whitespace-only values', () => {
  assert.equal(requireNonBlank('demo', 'packageName', '  ').code, 'INVALID_ARGUMENT');
  assert.equal(requireNonBlank('demo', 'packageName', 'com.example.app'), undefined);
});
