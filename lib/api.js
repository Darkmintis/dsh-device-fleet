/**
 * HTTP JSON API behind the Device fleet panel.
 *
 * The panel is a browser surface, so it needs data outside the conversation
 * tool pipeline. Every route is registered through the composed `webServer` and
 * admitted by the `connection` trust fence exactly like a built-in `/api` route:
 * an unauthenticated request is rejected before any adb command runs. Responses
 * carry both the structured service value and its rendered text so the panel and
 * the agent see the same facts.
 *
 * The API is user-driven. Destructive panel actions (install, clear data) are
 * confirmed in the panel by the human who clicked them; the agent path keeps its
 * approval gate. Both paths call the same `lib/service.js` operations, so the
 * side effects, validation, and error shapes are identical.
 *
 * @module
 */

import { readFile } from 'node:fs/promises';
import { renderText } from './render.js';

/** Serials selected in the panel gateway; actions target this set by default. */
const selectedSerials = new Set();

/** Prefix owned by this plugin; nothing else may register under it. */
export const FLEET_API_PREFIX = '/dsh-device-fleet/api';

/** Plugin version reported to the panel so a stale Host generation is visible. */
export const PLUGIN_VERSION = '0.1.0';

/** Panel request bodies are small JSON objects; anything larger is hostile. */
const MAX_BODY_BYTES = 128 * 1024;

/** Actions the panel can invoke, mapped to the service method they run. */
const ACTIONS = Object.freeze({
  install: 'install',
  launch: 'launch',
  stop: 'stop',
  clear: 'clearData',
  deep_link: 'deepLink',
  logcat: 'logcat',
  screenshot: 'screenshot',
  relaunch: 'relaunch',
  mirror: 'mirror',
});

/**
 * Register the panel API on the plugin context.
 *
 * @param {any} ctx Plugin context with `webServer` and `connection`.
 * @param {ReturnType<typeof import('./service.js').createFleetService>} service Fleet service.
 * @returns {void}
 */
export function registerFleetApi(ctx, service) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: FLEET_API_PREFIX,
        handler: (
          /** @type {import('node:http').IncomingMessage} */ req,
          /** @type {import('node:http').ServerResponse} */ res,
        ) => handle(ctx, service, req, res),
      }),
    'device-fleet: panel http api',
  );
}

/**
 * Route one panel request.
 *
 * @param {any} ctx Plugin context.
 * @param {ReturnType<typeof import('./service.js').createFleetService>} service Fleet service.
 * @param {import('node:http').IncomingMessage} req Request.
 * @param {import('node:http').ServerResponse} res Response.
 * @returns {Promise<void>} settled response.
 */
async function handle(ctx, service, req, res) {
  try {
    const rejection = ctx.connection.requestRejection(req);
    if (rejection !== undefined) {
      res.statusCode = rejection;
      res.end();
      return;
    }
    const url = new URL(String(req.url ?? '/'), 'http://localhost');
    const endpoint = url.pathname.slice(FLEET_API_PREFIX.length).replace(/^\/+/u, '').replace(/\/+$/u, '');
    if (req.method === 'GET' && (endpoint === 'devices' || endpoint === 'state')) {
      sendJson(res, 200, await devices(service, url));
      return;
    }
    if (req.method === 'GET' && endpoint === 'logs') {
      sendJson(res, 200, await logs(service, url));
      return;
    }
    if (req.method === 'GET' && endpoint === 'screenshot') {
      await screenshot(service, url, res);
      return;
    }
    if (req.method === 'POST' && endpoint === 'select') {
      const body = await readJsonBody(req);
      selectedSerials.clear();
      for (const serial of Array.isArray(body?.serials) ? body.serials : []) {
        if (typeof serial === 'string' && serial !== '') selectedSerials.add(serial);
      }
      sendJson(res, 200, { ok: true, pluginVersion: PLUGIN_VERSION, selected: [...selectedSerials] });
      return;
    }
    if (req.method === 'POST' && endpoint === 'action') {
      sendJson(res, 200, await action(service, req));
      return;
    }
    if (req.method === 'POST' && endpoint === 'adb/restart') {
      sendJson(res, 200, { ok: true, pluginVersion: PLUGIN_VERSION, value: await service.restartAdb() });
      return;
    }
    if (req.method === 'GET' && endpoint === 'scrcpy') {
      sendJson(res, 200, { ok: true, pluginVersion: PLUGIN_VERSION, value: service.capabilities() });
      return;
    }
    if (req.method === 'GET' && endpoint === 'version') {
      sendJson(res, 200, { ok: true, pluginVersion: PLUGIN_VERSION });
      return;
    }
    sendJson(res, 404, { ok: false, error: `unknown fleet api endpoint: ${endpoint}` });
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, 500, {
        ok: false,
        error: 'fleet api failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    } else {
      res.end();
    }
  }
}

/**
 * `GET devices`: the fleet listing.
 *
 * @param {ReturnType<typeof import('./service.js').createFleetService>} service Fleet service.
 * @param {URL} url Request URL; `packageName` adds each device's app version.
 * @returns {Promise<Record<string, unknown>>} panel payload.
 */
async function devices(service, url) {
  const packageName = url.searchParams.get('packageName') ?? undefined;
  const value = await service.list(packageName === undefined || packageName === '' ? {} : { packageName });
  return { ok: true, pluginVersion: PLUGIN_VERSION, selected: [...selectedSerials], value, text: renderText(value) };
}

/**
 * `GET logs?serial=…&serials=a,b&preset=…&filter=…&lines=…`: bounded log snapshot.
 *
 * @param {ReturnType<typeof import('./service.js').createFleetService>} service Fleet service.
 * @param {URL} url Request URL.
 * @returns {Promise<Record<string, unknown>>} panel payload.
 */
async function logs(service, url) {
  const preset = url.searchParams.get('preset') ?? 'all';
  const filter = url.searchParams.get('filter') ?? undefined;
  const lines = clampLines(url.searchParams.get('lines'));
  const serials = await targetSerials(service, url.searchParams.get('serial'), url.searchParams.get('serials'));
  if (typeof serials === 'string') return { ok: false, error: serials };
  /** @type {Array<Record<string, unknown>>} */
  const deviceResults = [];
  for (const serial of serials) {
    const value = await service.logcat({ serial, preset, filter, lines });
    deviceResults.push({ serial, value, text: renderText(value) });
  }
  return { ok: true, pluginVersion: PLUGIN_VERSION, value: { devices: deviceResults } };
}

/**
 * `GET screenshot?serial=…`: capture and stream a PNG.
 *
 * @param {ReturnType<typeof import('./service.js').createFleetService>} service Fleet service.
 * @param {URL} url Request URL.
 * @param {import('node:http').ServerResponse} res Response.
 * @returns {Promise<void>} settled response.
 */
async function screenshot(service, url, res) {
  const serial = url.searchParams.get('serial');
  if (serial === null || serial === '') {
    sendJson(res, 400, { ok: false, error: 'screenshot requires ?serial=' });
    return;
  }
  const value = await service.screenshot({ serial });
  if (value.ok !== true) {
    sendJson(res, 200, { ok: false, pluginVersion: PLUGIN_VERSION, value, text: renderText(value) });
    return;
  }
  const bytes = await readFile(/** @type {string} */ (value.path));
  res.statusCode = 200;
  res.setHeader('content-type', 'image/png');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-fleet-serial', serial);
  res.end(bytes);
}

/**
 * `POST action`: run one fleet action on one or all devices.
 *
 * @param {ReturnType<typeof import('./service.js').createFleetService>} service Fleet service.
 * @param {import('node:http').IncomingMessage} req Request.
 * @returns {Promise<Record<string, unknown>>} panel payload.
 */
async function action(service, req) {
  const body = await readJsonBody(req);
  if (body === null) return { ok: false, error: 'request body must be a JSON object under 128 KiB' };
  const actionName = body.action;
  if (typeof actionName !== 'string' || !(actionName in ACTIONS)) {
    return { ok: false, error: `unknown action: ${String(actionName)}` };
  }
  const serials = await targetSerials(service, undefined, Array.isArray(body.serials) ? body.serials.join(',') : body.serials);
  if (typeof serials === 'string') return { ok: false, error: serials };
  if (serials.length === 0) return { ok: false, error: 'no ready device is connected' };
  const base = {
    ...(typeof body.packageName === 'string' ? { packageName: body.packageName } : {}),
    ...(typeof body.apkPath === 'string' ? { apkPath: body.apkPath } : {}),
    ...(typeof body.url === 'string' ? { url: body.url } : {}),
    ...(typeof body.command === 'string' ? { command: body.command } : {}),
    ...(body.preset !== undefined ? { preset: body.preset } : {}),
    ...(body.filter !== undefined ? { filter: body.filter } : {}),
    ...(body.lines !== undefined ? { lines: body.lines } : {}),
  };
  /** @type {Array<Record<string, unknown>>} */
  const results = [];
  for (const serial of serials) {
    const method = /** @type {keyof typeof ACTIONS} */ (actionName);
    const value = await runAction(service, method, serial, base);
    results.push({ serial, ok: value.ok === true, value, text: renderText(value) });
  }
  const failed = results.filter((entry) => entry.ok !== true).length;
  return {
    ok: true,
    pluginVersion: PLUGIN_VERSION,
    action: actionName,
    results,
    text: `${actionName}: ${results.length - failed}/${results.length} device(s) succeeded`,
  };
}

/**
 * Dispatch one action to one device through the shared service.
 *
 * @param {ReturnType<typeof import('./service.js').createFleetService>} service Fleet service.
 * @param {keyof typeof ACTIONS} actionName Panel action name.
 * @param {string} serial Target serial.
 * @param {Record<string, any>} base Shared action arguments.
 * @returns {Promise<Record<string, unknown>>} service result.
 */
async function runAction(service, actionName, serial, base) {
  switch (actionName) {
    case 'install':
      return service.install({ serial, apkPath: String(base.apkPath ?? '') });
    case 'launch':
      return service.launch({ serial, packageName: String(base.packageName ?? '') });
    case 'stop': {
      const packageName = await resolvePackage(service, serial, base);
      if (typeof packageName !== 'string') return packageName;
      return service.stop({ serial, packageName });
    }
    case 'clear': {
      const packageName = await resolvePackage(service, serial, base);
      if (typeof packageName !== 'string') return packageName;
      return service.clearData({ serial, packageName });
    }
    case 'deep_link':
      return service.deepLink({ serial, url: String(base.url ?? '') });
    case 'logcat':
      return service.logcat({ serial, preset: base.preset, filter: base.filter, lines: base.lines });
    case 'screenshot':
      return service.screenshot({ serial });
    case 'mirror':
      return service.mirror({ serial });
    case 'relaunch': {
      const packageName = await resolvePackage(service, serial, base);
      if (typeof packageName !== 'string') return packageName;
      const launched = await service.launch({ serial, packageName });
      return { ...launched, relaunched: packageName };
    }

    default:
      return { ok: false, error: `unknown action: ${actionName}` };
  }
}

/**
 * Resolve the package for a panel action: the explicit body value first, then
 * the device's currently resumed app so the panel needs no package input.
 *
 * @param {ReturnType<typeof import('./service.js').createFleetService>} service Fleet service.
 * @param {string} serial Target device.
 * @param {Record<string, any>} base Shared action arguments.
 * @returns {Promise<string | Record<string, unknown>>} package name or a failure envelope.
 */
async function resolvePackage(service, serial, base) {
  if (typeof base.packageName === 'string' && base.packageName !== '') return base.packageName;
  const foreground = await service.foreground({ serial });
  if (foreground.ok !== true) return foreground;
  const packageName = typeof foreground.packageName === 'string' ? foreground.packageName : '';
  if (packageName === '') return { ok: false, error: 'no foreground app; open the app on the device first' };
  return packageName;
}

/**
 * Resolve the serial selection for a request.
 *
 * @param {ReturnType<typeof import('./service.js').createFleetService>} service Fleet service.
 * @param {string | null | undefined} single `serial` query value.
 * @param {string | null | undefined | string[]} many `serials` query value or body value.
 * @returns {Promise<string[] | string>} serial list, or an error message.
 */
async function targetSerials(service, single, many) {
  if (typeof single === 'string' && single !== '') return [single];
  if (many === undefined && selectedSerials.size > 0) return [...selectedSerials];
  if (Array.isArray(many)) {
    const values = many.filter((value) => typeof value === 'string' && value !== '');
    if (values.length > 0) return values;
  }
  if (typeof many === 'string' && many !== '' && many !== 'all') {
    return many
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value !== '');
  }
  const listing = await service.list({});
  if (listing.ok !== true) return typeof listing.error === 'string' ? listing.error : 'device listing failed';
  const ready = Array.isArray(listing.devices)
    ? listing.devices
        .map((device) => (device !== null && typeof device === 'object' && typeof device.serial === 'string' ? device.serial : undefined))
        .filter((serial) => serial !== undefined)
    : [];
  if (ready.length === 0) return 'no ready device is connected';
  return /** @type {string[]} */ (ready);
}

/**
 * Read a bounded JSON request body.
 *
 * @param {import('node:http').IncomingMessage} req Request.
 * @returns {Promise<Record<string, any> | null>} parsed object, or null when invalid/oversized.
 */
async function readJsonBody(req) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * @param {string | null} value Raw line count.
 * @returns {number} bounded line count.
 */
function clampLines(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 200;
  return Math.min(2_000, Math.max(1, Math.trunc(parsed)));
}

/**
 * Write one JSON response.
 *
 * @param {import('node:http').ServerResponse} res Response.
 * @param {number} status Status code.
 * @param {unknown} payload JSON payload.
 * @returns {void}
 */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}
