/**
 * Host half of `@darkmintis/dsh-device-fleet`.
 *
 * Registers the adb cockpit tools and the approval gate for destructive
 * operations. All device work is delegated to `lib/service.js`, which runs adb
 * as bounded child processes and never blocks the harness event loop.
 *
 * @module
 */

import { createFleetService } from './lib/service.js';
import { registerApprovalGate, registerFleetTools } from './lib/tools.js';

/** The tool registry must be active before tools can be registered. */
export const inject = ['tools'];

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
}
