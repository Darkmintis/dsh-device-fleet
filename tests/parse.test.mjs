import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearSucceeded,
  installSucceeded,
  isEmulator,
  parseAvdList,
  parseBatteryLevel,
  parseDeviceList,
  parsePackageVersion,
  parsePngSize,
  parseProps,
  parseResolvedComponent,
  parseScreenAwake,
  serialForFilename,
} from '../lib/parse.js';

test('parseDeviceList parses qualifiers, states, and warnings', () => {
  const output = [
    'List of devices attached',
    'R58M12345\tdevice usb:1-1 product:beyond1ltexx model:SM_G973F device:beyond1 transport_id:3',
    'emulator-5554\tdevice product:sdk_gphone_x86 model:sdk_gphone_x86 device:generic_x86 transport_id:4',
    'ABC123\tunauthorized usb:1-2',
    'XYZ789\toffline',
    '* daemon started successfully',
    '',
  ].join('\n');
  const { devices, warnings } = parseDeviceList(output);
  assert.equal(devices.length, 4);
  assert.deepEqual(devices[0], {
    serial: 'R58M12345',
    state: 'device',
    model: 'SM G973F',
    product: 'beyond1ltexx',
    device: 'beyond1',
    transportId: '3',
    usb: '1-1',
  });
  assert.equal(devices[1].serial, 'emulator-5554');
  assert.equal(devices[2].state, 'unauthorized');
  assert.equal(devices[3].state, 'offline');
  assert.equal(warnings.length, 1);
});

test('parseDeviceList keeps unusual rows as warnings instead of crashing', () => {
  const { devices, warnings } = parseDeviceList('List of devices attached\n????????????\tno permissions (missing udev rule)\n');
  assert.equal(devices.length, 1);
  assert.equal(devices[0].state, 'unknown');
  assert.match(String(devices[0].note), /permissions \(missing udev rule\)/u);
  assert.equal(warnings.length, 0);
});

test('parseProps reads the getprop map', () => {
  const props = parseProps('[ro.product.model]: [SM_G973F]\n[ro.kernel.qemu]: []\nmalformed line\n');
  assert.equal(props['ro.product.model'], 'SM_G973F');
  assert.equal(props['ro.kernel.qemu'], '');
  assert.equal(Object.keys(props).length, 2);
});

test('isEmulator detects serials, qemu props, and emulator models', () => {
  assert.equal(isEmulator({ serial: 'emulator-5554', state: 'device' }), true);
  assert.equal(isEmulator({ serial: 'R58M12345', state: 'device' }, { 'ro.kernel.qemu': '1' }), true);
  assert.equal(isEmulator({ serial: 'R58M12345', state: 'device' }, { 'ro.product.model': 'sdk_gphone_x86' }), true);
  assert.equal(isEmulator({ serial: 'R58M12345', state: 'device' }, { 'ro.product.model': 'SM_G973F' }), false);
  assert.equal(isEmulator(undefined), false);
});

test('parseBatteryLevel accepts 0-100 and rejects junk', () => {
  assert.equal(parseBatteryLevel('  level: 87\n  scale: 100\n'), 87);
  assert.equal(parseBatteryLevel('  level: 0\n'), 0);
  assert.equal(parseBatteryLevel('  level: 101\n'), undefined);
  assert.equal(parseBatteryLevel('no battery data'), undefined);
});

test('parseScreenAwake reads wakefulness, screen flags, and display state', () => {
  assert.equal(parseScreenAwake('mWakefulness=Awake'), true);
  assert.equal(parseScreenAwake('mWakefulness=Asleep'), false);
  assert.equal(parseScreenAwake('mScreenOn=true'), true);
  assert.equal(parseScreenAwake('mScreenOnFully=false'), false);
  assert.equal(parseScreenAwake('Display Power: state=ON'), true);
  assert.equal(parseScreenAwake('unrelated'), undefined);
});

test('parsePackageVersion scopes to the requested package', () => {
  const output = [
    'Packages:',
    '  Package [com.other.app] (aaa):',
    '    versionCode=1 minSdk=21',
    '    versionName=0.0.1',
    '  Package [com.example.app] (bbb):',
    '    userId=10123',
    '    versionCode=42 minSdk=21 targetSdk=34',
    '    versionName=1.2.3',
  ].join('\n');
  assert.deepEqual(parsePackageVersion(output, 'com.example.app'), { versionCode: '42', versionName: '1.2.3' });
  assert.deepEqual(parsePackageVersion(output, 'com.other.app'), { versionCode: '1', versionName: '0.0.1' });
  assert.equal(parsePackageVersion(output, 'com.missing'), undefined);
});

test('parseResolvedComponent takes the last component-shaped line', () => {
  assert.equal(
    parseResolvedComponent('priority=0 preferredOrder=0\ncom.example.app/.MainActivity\n'),
    'com.example.app/.MainActivity',
  );
  assert.equal(parseResolvedComponent('No activity found'), undefined);
});

test('parsePngSize reads IHDR dimensions and rejects non-PNG bytes', () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  assert.deepEqual(parsePngSize(png), { width: 1, height: 1 });
  assert.equal(parsePngSize(Buffer.from('not a png at all, definitely not')), undefined);
  assert.equal(parsePngSize(undefined), undefined);
});

test('parseAvdList skips blank lines and emulator INFO noise', () => {
  assert.deepEqual(parseAvdList('Pixel_4a\n\nINFO | something\nPixel_6_API_34\n'), ['Pixel_4a', 'Pixel_6_API_34']);
});

test('install and clear success detection', () => {
  assert.equal(installSucceeded('Performing Streamed Install\nSuccess\n'), true);
  assert.equal(installSucceeded('Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]'), false);
  assert.equal(clearSucceeded('Success\n'), true);
  assert.equal(clearSucceeded('Failed\n'), false);
});

test('serialForFilename sanitises device serials', () => {
  assert.equal(serialForFilename('emulator-5554'), 'emulator-5554');
  assert.equal(serialForFilename('R58M/123:45'), 'R58M_123_45');
});
