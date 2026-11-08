import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, inject } from '../index.js';

/**
 * Build a mock plugin context.
 *
 * @returns {{ ctx: any, tools: Map<string, any>, listeners: Array<{ event: string, handler: Function }> }} mock context.
 */
function mockContext() {
  /** @type {Map<string, any>} */
  const tools = new Map();
  /** @type {Array<{ event: string, handler: Function }>} */
  const listeners = [];
  return {
    tools,
    listeners,
    ctx: {
      tools: {
        /** @param {any} definition Tool definition. */
        register(definition) {
          tools.set(definition.name, definition);
          return () => tools.delete(definition.name);
        },
      },
      /**
       * @param {string} event Event name.
       * @param {Function} handler Listener.
       */
      on(event, handler) {
        listeners.push({ event, handler });
        return () => {};
      },
      /** @param {Function} callback Effect body. */
      effect(callback) {
        const disposer = callback();
        return typeof disposer === 'function' ? disposer : () => {};
      },
      /** Optional Web services are absent in this test profile. */
      inject() {
        return () => {};
      },
    },
  };
}

test('index.js declares the tool registry dependency', () => {
  assert.deepEqual(inject, ['tools']);
});

test('apply mounts 12 tools and one approval listener without touching adb', () => {
  const { ctx, tools, listeners } = mockContext();
  assert.doesNotThrow(() => apply(ctx));
  assert.equal(tools.size, 12);
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].event, 'tools/pre-execute');
  for (const name of tools.keys()) {
    assert.match(name, /^(fleet_list|device_|emulator_)/u);
  }
});
