import assert from 'node:assert/strict';
import test from 'node:test';
import { FETCH_LINE_CAP, clampInt, selectLogcatLines, splitLogLines } from '../lib/logcat.js';

const LINES = [
  'I flutter : app started',
  'E flutter : Unhandled Exception: boom',
  'I UploadWorker: starting upload of /tmp/a.jpg',
  'E UploadWorker: upload failed: 413 payload too large',
  'D unrelated: noise line',
  'F DEBUG: FATAL EXCEPTION: main',
  'F DEBUG: ANR in com.example.app',
];

test('preset flutter selects Flutter errors, unhandled exceptions, and fatal exceptions', () => {
  const selection = selectLogcatLines(LINES, { preset: 'flutter' });
  assert.equal(selection.matched, 2);
  assert.deepEqual(selection.lines, [LINES[1], LINES[5]]);
  assert.equal(selection.presetLabel, 'Flutter exceptions');
});

test('preset crash selects fatal exceptions and ANRs', () => {
  const selection = selectLogcatLines(LINES, { preset: 'crash', limit: 10 });
  assert.deepEqual(selection.lines, [LINES[5], LINES[6]]);
});

test('preset upload selects upload flow lines and exposes the failure', () => {
  const selection = selectLogcatLines(LINES, { preset: 'upload' });
  assert.equal(selection.matched, 2);
  assert.ok(selection.lines.some((line) => line.includes('upload failed')));
});

test('preset all with a substring filter narrows case-insensitively', () => {
  const selection = selectLogcatLines(LINES, { preset: 'all', filter: 'UPLOAD' });
  assert.equal(selection.matched, 2);
  assert.equal(selection.filter, 'UPLOAD');
});

test('filter and preset combine', () => {
  assert.equal(selectLogcatLines(LINES, { preset: 'upload', filter: 'failed' }).matched, 1);
  assert.equal(selectLogcatLines(LINES, { preset: 'crash', filter: 'upload' }).matched, 0);
});

test('limit keeps the newest matching tail and marks truncation', () => {
  const selection = selectLogcatLines(LINES, { preset: 'all', limit: 3 });
  assert.equal(selection.matched, 7);
  assert.ok(selection.truncated);
  assert.deepEqual(selection.lines, [LINES[4], LINES[5], LINES[6]]);
});

test('unknown preset falls back to all', () => {
  const selection = selectLogcatLines(LINES, { preset: /** @type {any} */ ('nope') });
  assert.equal(selection.matched, 7);
  assert.equal(selection.preset, 'nope');
});

test('clampInt bounds values', () => {
  assert.equal(clampInt(0, 1, 10), 1);
  assert.equal(clampInt(99, 1, 10), 10);
  assert.equal(clampInt(Number.NaN, 2, 10), 2);
  assert.equal(clampInt('5', 1, 10), 5);
  assert.equal(FETCH_LINE_CAP, 4000);
});

test('splitLogLines drops blank trailing lines', () => {
  assert.deepEqual(splitLogLines('a\r\nb\n\n'), ['a', 'b']);
});
