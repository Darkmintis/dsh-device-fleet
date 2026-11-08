/**
 * Host half of `@darkmintis/dsh-device-fleet`.
 *
 * Registers the adb cockpit tools, the approval gate for destructive
 * operations, and — when the Web composition provides `webServer` and
 * `connection` — the HTTP API behind the Device fleet panel. All device work is
 * delegated to `lib/service.js`, which runs adb as bounded child processes and
 * never blocks the harness event loop.
 *
 * @module
 */

import { registerFleetApi } from './lib/api.js';
import { createFleetService } from './lib/service.js';
import { registerApprovalGate, registerFleetTools } from './lib/tools.js';

/** The tool registry must be active before tools can be registered. */
export const inject = ['tools'];

/** Plugin display name (also the client module id). */
export const name = '@darkmintis/dsh-device-fleet';

/**
 * Mount the plugin.
 *
 * @param {any} ctx Host plugin context.
 * @returns {void}
 */
export function apply(ctx) {
  const service = createFleetService();
  registerFleetTools(ctx, service);
  registerApprovalGate(ctx);
  // The panel API only exists where a browser Web composition is mounted; a
  // headless profile keeps the tools and simply has no panel routes.
  ctx.inject(['webServer', 'connection'], (/** @type {any} */ apiCtx) => {
    registerFleetApi(apiCtx, service);
  });
}
