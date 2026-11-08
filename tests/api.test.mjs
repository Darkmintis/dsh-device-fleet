import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FLEET_API_PREFIX, registerFleetApi } from '../lib/api.js';
import { TIMEOUTS } from '../lib/adb.js';
import { createFleetService } from '../lib/service.js';
import { createFakeSpawn } from './support/fake-process.mjs';

/** Fast bounded timeouts for the scripted adb. */
const FAST_TIMEOUTS = Object.fromEntries(Object.keys(TIMEOUTS).map((key) => [key, 2_000]));

/**
 * Build a fleet service wired to the scripted fake adb.
 *
 * @param {string} scenario Fake adb scenario.
 * @param {string} root Temp root.
 * @returns {ReturnType<typeof createFleetService>} service.
 */
function makeService(scenario, root) {
  return createFleetService({
    adbPath: path.join(root, 'fake-adb'),
    spawn: /** @type {any} */ (createFakeSpawn()),
    env: { ...process.env, FAKE_ADB_SCENARIO: scenario, FAKE_ADB_STATE_DIR: path.join(root, 'state') },
    tmpRoot: path.join(root, 'tmp'),
    timeouts: FAST_TIMEOUTS,
  });
}

/**
 * Build the plugin-context shape `registerFleetApi` uses.
 *
 * @param {ReturnType<typeof createFleetService>} service Fleet service.
 * @param {{ reject?: number }} [options] Auth behavior override.
 * @returns {{ ctx: any, call: (req: any, res: any) => Promise<void> }} captured API context.
 */
function makeApi(service, options = {}) {
  /** @type {any} */
  let route;
  const ctx = {
    effect: (callback) => {
      callback();
      return () => {};
    },
    webServer: {
      register: (registered) => {
        route = registered;
        return () => {};
      },
    },
    connection: {
      requestRejection: () => options.reject,
    },
  };
  registerFleetApi(ctx, service);
  assert.equal(route.kind, 'prefix');
  assert.equal(route.path, FLEET_API_PREFIX);
  return { ctx, call: route.handler };
}

/**
 * Fake HTTP response recorder.
 *
 * @returns {any} response double.
 */
function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    headersSent: false,
    body: undefined,
    ended: false,
    /**
     * @param {string} name Header name.
     * @param {unknown} value Header value.
     */
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    /** @param {unknown} chunk Response body. */
    end(chunk) {
      this.body = chunk;
      this.ended = true;
    },
    /** @param {unknown} chunk Streamed chunk. */
    write(chunk) {
      this.body = this.body === undefined ? chunk : this.body + chunk;
    },
  };
}

/**
 * Fake HTTP request with an async-iterable body.
 *
 * @param {{ method?: string, url: string, body?: unknown, headers?: Record<string, string> }} options Request options.
 * @returns {any} request double.
 */
function makeReq(options) {
  const body = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body));
  return {
    method: options.method ?? 'GET',
    url: options.url,
    headers: options.headers ?? {},
    /** @returns {AsyncGenerator<Buffer>} body chunks. */
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield body;
    },
  };
}

/**
 * @param {any} res Response double.
 * @returns {any} parsed JSON body.
 */
function jsonBody(res) {
  return JSON.parse(String(res.body));
}

test('panel API rejects an unauthenticated request before doing any work', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-fleet-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = makeService('single', root);
  const { call } = makeApi(service, { reject: 401 });
  const res = makeRes();
  await call(makeReq({ url: `${FLEET_API_PREFIX}/devices` }), res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.ended, true);
  assert.equal(res.body, undefined);
});

test('GET devices returns the structured fleet and rendered text', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-fleet-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = makeService('mixed', root);
  const { call } = makeApi(service);
  const res = makeRes();
  await call(makeReq({ url: `${FLEET_API_PREFIX}/devices` }), res);
  const payload = jsonBody(res);
  assert.equal(res.statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.pluginVersion, '0.1.0');
  assert.equal(payload.value.count, 2);
  assert.equal(payload.value.devices[1].isEmulator, true);
  assert.match(String(payload.text), /emulator-5554/u);
  assert.equal(payload.value.unauthorized.length, 1);
});

test('GET devices accepts packageName for per-device app versions', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-fleet-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = makeService('single', root);
  const { call } = makeApi(service);
  const res = makeRes();
  await call(makeReq({ url: `${FLEET_API_PREFIX}/devices?packageName=com.example.app` }), res);
  const payload = jsonBody(res);
  assert.deepEqual(payload.value.devices[0].package, { name: 'com.example.app', versionName: '1.2.3', versionCode: '42' });
});

test('POST action fans out one operation across every ready device', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-fleet-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = makeService('multi', root);
  const { call } = makeApi(service);
  const res = makeRes();
  await call(
    makeReq({
      method: 'POST',
      url: `${FLEET_API_PREFIX}/action`,
      body: { action: 'launch', packageName: 'com.example.app', serials: 'all' },
    }),
    res,
  );
  const payload = jsonBody(res);
  assert.equal(payload.ok, true);
  assert.equal(payload.action, 'launch');
  assert.equal(payload.results.length, 2);
  for (const result of payload.results) assert.equal(result.ok, true, result.serial);
  const serials = payload.results.map((result) => result.serial).sort();
  assert.deepEqual(serials, ['R58M12345', 'emulator-5554']);
});

test('POST action can target one device and reports an install failure', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-fleet-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = makeService('install-fail', root);
  const { call } = makeApi(service);
  const apk = path.join(root, 'app-debug.apk');
  await writeFile(apk, Buffer.concat([Buffer.from('PK\u0003\u0004', 'latin1'), Buffer.alloc(16)]));
  const res = makeRes();
  await call(
    makeReq({
      method: 'POST',
      url: `${FLEET_API_PREFIX}/action`,
      body: { action: 'install', apkPath: apk, serials: ['R58M12345'] },
    }),
    res,
  );
  const payload = jsonBody(res);
  assert.equal(payload.results.length, 1);
  assert.equal(payload.results[0].ok, false);
  assert.match(String(payload.results[0].text), /INSTALL_FAILED_UPDATE_INCOMPATIBLE/u);
});

test('GET logs aggregates a bounded log snapshot per device', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-fleet-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = makeService('multi', root);
  const { call } = makeApi(service);
  const res = makeRes();
  await call(makeReq({ url: `${FLEET_API_PREFIX}/logs?serials=all&preset=upload&lines=20` }), res);
  const payload = jsonBody(res);
  assert.equal(payload.ok, true);
  assert.equal(payload.value.devices.length, 2);
  const lines = payload.value.devices[0].value.lines;
  assert.ok(lines.some((line) => String(line).includes('upload failed')));
});

test('GET screenshot streams a PNG for one device', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-fleet-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = makeService('multi', root);
  const { call } = makeApi(service);
  const res = makeRes();
  await call(makeReq({ url: `${FLEET_API_PREFIX}/screenshot?serial=emulator-5554` }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(res.headers['x-fleet-serial'], 'emulator-5554');
  assert.equal(Buffer.isBuffer(res.body), true);
  assert.equal(res.body.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('unknown endpoints and unsupported actions answer with a clear error', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-fleet-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = makeService('single', root);
  const { call } = makeApi(service);
  const missing = makeRes();
  await call(makeReq({ url: `${FLEET_API_PREFIX}/nope` }), missing);
  assert.equal(missing.statusCode, 404);
  assert.match(String(jsonBody(missing).error), /unknown fleet api endpoint: nope/u);

  const badAction = makeRes();
  await call(makeReq({ method: 'POST', url: `${FLEET_API_PREFIX}/action`, body: { action: 'reboot-everything' } }), badAction);
  assert.match(String(jsonBody(badAction).error), /unknown action/u);

  const badBody = makeRes();
  await call(makeReq({ method: 'POST', url: `${FLEET_API_PREFIX}/action`, body: ['not', 'an', 'object'] }), badBody);
  assert.match(String(jsonBody(badBody).error), /JSON object/u);
});

test('GET version reports the running Host generation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-fleet-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = makeService('single', root);
  const { call } = makeApi(service);
  const res = makeRes();
  await call(makeReq({ url: `${FLEET_API_PREFIX}/version` }), res);
  assert.deepEqual(jsonBody(res), { ok: true, pluginVersion: '0.1.0' });
});

test('the panel selection drives actions without explicit serials', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-fleet-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = makeService('multi', root);
  const { call } = makeApi(service);

  const selectRes = makeRes();
  await call(makeReq({ method: 'POST', url: `${FLEET_API_PREFIX}/select`, body: { serials: ['emulator-5554'] } }), selectRes);
  const selected = jsonBody(selectRes);
  assert.equal(selected.ok, true);
  assert.deepEqual(selected.selected, ['emulator-5554']);

  const devicesRes = makeRes();
  await call(makeReq({ url: `${FLEET_API_PREFIX}/devices` }), devicesRes);
  assert.deepEqual(jsonBody(devicesRes).selected, ['emulator-5554']);

  const actionRes = makeRes();
  await call(makeReq({ method: 'POST', url: `${FLEET_API_PREFIX}/action`, body: { action: 'launch', packageName: 'com.example.app' } }), actionRes);
  const action = jsonBody(actionRes);
  assert.deepEqual(action.results.map((result) => result.serial), ['emulator-5554'], 'only the selection is targeted');
});

test('relaunch and stop resolve the foreground app instead of asking for a package', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-fleet-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = makeService('single', root);
  const { call } = makeApi(service);

  const relaunchRes = makeRes();
  await call(makeReq({ method: 'POST', url: `${FLEET_API_PREFIX}/action`, body: { action: 'relaunch', serials: ['R58M12345'] } }), relaunchRes);
  const relaunch = jsonBody(relaunchRes);
  assert.equal(relaunch.results[0].ok, true, relaunch.results[0].text);
  assert.equal(relaunch.results[0].value.relaunched, 'com.example.app');

  const stopRes = makeRes();
  await call(makeReq({ method: 'POST', url: `${FLEET_API_PREFIX}/action`, body: { action: 'stop', serials: ['R58M12345'] } }), stopRes);
  const stop = jsonBody(stopRes);
  assert.equal(stop.results[0].ok, true, stop.results[0].text);
  assert.equal(stop.results[0].value.packageName, 'com.example.app');
});