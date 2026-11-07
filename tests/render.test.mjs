import assert from 'node:assert/strict';
import test from 'node:test';
import { renderResult, renderText } from '../lib/render.js';

test('fleet_list renders a table with models, battery, and unauthorized hints', () => {
  const text = renderText({
    ok: true,
    tool: 'fleet_list',
    adb: { path: 'C:/android/platform-tools/adb.exe', version: '1.0.41' },
    androidSdk: 'C:/android/sdk',
    count: 2,
    total: 3,
    devices: [
      {
        serial: 'R58M12345',
        state: 'device',
        model: 'SM_G973F',
        androidVersion: '13',
        sdk: 33,
        batteryPct: 87,
        screenOn: true,
        isEmulator: false,
        package: { versionName: '1.2.3', versionCode: '42' },
      },
      {
        serial: 'emulator-5554',
        state: 'device',
        model: 'sdk_gphone_x86',
        androidVersion: '14',
        sdk: 34,
        batteryPct: 100,
        screenOn: false,
        isEmulator: true,
      },
    ],
    unauthorized: [{ serial: 'ABC123', model: 'SM_G973F', hint: 'Tap "Allow USB debugging" on SM_G973F' }],
  });
  assert.match(text, /adb: C:\/android\/platform-tools\/adb\.exe v1\.0\.41/u);
  assert.match(text, /Devices: 2 ready \/ 3 connected/u);
  assert.match(text, /SERIAL\s+STATE\s+MODEL/u);
  assert.match(text, /R58M12345\s+device\s+SM_G973F\s+13\s+33\s+87%\s+on\s+phone/u);
  assert.match(text, /emulator-5554\s+device\s+sdk_gphone_x86\s+14\s+34\s+100%\s+off\s+emulator/u);
  assert.match(text, /Action needed:/u);
  assert.match(text, /ABC123: Tap "Allow USB debugging"/u);
});

test('fleet_list with no devices explains what to do', () => {
  const text = renderText({ ok: true, tool: 'fleet_list', count: 0, total: 0, devices: [] });
  assert.match(text, /Devices: 0 ready \/ 0 connected/u);
  assert.match(text, /No ready devices/u);
});

test('failures render the code, message, hint, and bounded details', () => {
  const blocks = renderResult({ ok: false, code: 'ADB_NOT_FOUND', error: 'adb was not found on this machine.', hint: 'Install platform-tools.' });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /Error \[ADB_NOT_FOUND\]: adb was not found on this machine\./u);
  assert.match(blocks[0].text, /Hint: Install platform-tools\./u);
  const withDetails = renderText({ ok: false, code: 'X', error: 'y', details: { devices: [{ serial: 'A' }] } });
  assert.match(withDetails, /Details: \{"devices":\[\{"serial":"A"\}\]\}/u);
});

test('logcat renders the preset header, counts, and tail', () => {
  const text = renderText({
    ok: true,
    tool: 'device_logcat',
    serial: 'R58M12345',
    preset: 'upload',
    presetLabel: 'Upload flow',
    filter: 'fail',
    total: 7,
    matched: 1,
    lines: ['E UploadWorker: upload failed: 413'],
    truncated: false,
  });
  assert.match(text, /logcat R58M12345 · preset=upload filter="fail" · 1\/7 lines matched/u);
  assert.match(text, /upload failed: 413/u);

  const empty = renderText({ ok: true, tool: 'device_logcat', serial: 'X', preset: 'crash', total: 7, matched: 0, lines: [] });
  assert.match(empty, /No matching lines\./u);
});

test('screenshot and which results render actionable text', () => {
  const shot = renderText({ ok: true, tool: 'device_screenshot', path: 'C:/tmp/shot.png', serial: 'X', width: 1080, height: 2400, bytes: 204800 });
  assert.match(shot, /Screenshot saved: C:\/tmp\/shot\.png/u);
  assert.match(shot, /read_image/u);
  const which = renderText({
    ok: true,
    tool: 'device_which',
    platform: 'win32',
    adb: { found: true, path: 'C:/adb.exe', source: 'PATH', version: '1.0.41' },
    java: { found: false, hint: 'Install a JDK or set JAVA_HOME.' },
  });
  assert.match(which, /adb: C:\/adb\.exe \(PATH\) v1\.0\.41/u);
  assert.match(which, /java: not found — Install a JDK/u);
});

test('generic results render the headline, facts, and output', () => {
  const text = renderText({
    ok: true,
    tool: 'device_shell',
    serial: 'R58M12345',
    command: 'pm list packages',
    exitCode: 0,
    stdout: 'package:com.example.app',
  });
  assert.match(text, /Shell command completed\./u);
  assert.match(text, /R58M12345/u);
  assert.match(text, /exit 0/u);
  assert.match(text, /stdout:\npackage:com\.example\.app/u);
});
