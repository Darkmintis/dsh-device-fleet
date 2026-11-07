import assert from 'node:assert/strict';
import test from 'node:test';
import { lossless } from '../lib/json.js';

test('lossless drops undefined object properties and keeps values', () => {
  const value = { ok: true, a: 1, b: undefined, nested: { c: 'x', d: undefined }, list: [1, undefined, 3] };
  assert.deepEqual(lossless(value), { ok: true, a: 1, nested: { c: 'x' }, list: [1, null, 3] });
});

test('lossless round-trips through JSON without losing information', () => {
  const value = {
    ok: true,
    tool: 'fleet_list',
    count: 1,
    devices: [{ serial: 'R58M12345', model: undefined, batteryPct: 87, screenOn: true }],
    ignored: undefined,
  };
  const normalised = lossless(value);
  assert.deepEqual(JSON.parse(JSON.stringify(normalised)), normalised);
  assert.equal('ignored' in normalised, false);
  assert.equal('model' in normalised.devices[0], false);
});

test('lossless normalises non-finite numbers and unsupported values', () => {
  assert.deepEqual(lossless({ a: Number.NaN, b: Number.POSITIVE_INFINITY, c: () => 1, d: Symbol('x') }), { a: null, b: null });
  assert.equal(lossless(undefined), null);
  assert.equal(lossless(5), 5);
  assert.equal(lossless('x'), 'x');
});
