import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { expect, test, vi } from 'vitest';
import { config } from '../../tests/helpers/center.ts';
import contribute from '../server/plugin.ts';

test('Reloading the contribution releases the previous listener, subscriptions and timers.', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-lifecycle-'));
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP port');
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const daemon = join(dir, 'daemon');
  const conf = join(dir, 'paseo-task-manager', 'srv_fixture');
  mkdirSync(daemon);
  mkdirSync(conf, { recursive: true });
  writeFileSync(join(daemon, 'config.json'), '{}');
  writeFileSync(join(daemon, 'paseo.pid'), JSON.stringify({ listen: '127.0.0.1:6767' }));
  writeFileSync(join(daemon, 'server-id'), 'srv_fixture');
  vi.stubEnv('PASEO_HOME', daemon);
  vi.stubEnv('XDG_CONFIG_HOME', dir);
  vi.stubEnv('XDG_STATE_HOME', join(dir, 'state'));
  vi.stubGlobal('CHECKOUT_WEB_DIR', dir);
  writeFileSync(join(conf, 'config.json'), JSON.stringify({ ...config, port: address.port, dbPath: join(dir, 'center.db'), understanding: { enabled: false } }));
  const endpoint = `http://127.0.0.1:${address.port}/status`;
  const unsubscribe = vi.fn();
  try {
    for (let i = 0; i < 2; i++) {
      const cleanup = contribute({
        registerSettings: definition => ({
          read: async () => ({ status: 'ready', revision: '', values: definition.schema.parse({}) }),
          subscribe: () => unsubscribe,
        }),
        handle: () => {},
      });
      try {
        await vi.waitFor(async () => expect((await fetch(endpoint)).ok).toBe(true));
      } finally {
        await cleanup();
      }
      expect(unsubscribe).toHaveBeenCalledTimes(i + 1);
      await expect(fetch(endpoint)).rejects.toThrow();
    }
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});
