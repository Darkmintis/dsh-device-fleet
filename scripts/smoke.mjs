#!/usr/bin/env node
/**
 * Manual smoke script: probes this machine's adb setup and, when a device is
 * connected, prints a fleet listing. It is not part of the test suite because it
 * depends on real hardware; CI runs the deterministic fake-adb tests instead.
 *
 * Usage: node scripts/smoke.mjs [--serial <serial>]
 */

import process from 'node:process';
import { createFleetService } from '../lib/service.js';

const args = process.argv.slice(2);
const serialIndex = args.indexOf('--serial');
const serial = serialIndex === -1 ? undefined : args[serialIndex + 1];

const service = createFleetService();
const which = await service.which();
console.log('device_which:');
console.log(JSON.stringify(which, null, 2));
console.log('\nfleet_list:');
const listing = await service.list(serial === undefined ? {} : { serial });
console.log(JSON.stringify(listing, null, 2));
process.exitCode = listing.ok === true ? 0 : 2;
