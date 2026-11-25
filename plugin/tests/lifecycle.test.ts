import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { config } from '../../tests/helpers/center.ts';
import { FakePaseo, FAKE_SERVER_ID } from './helpers/fake-paseo.ts';
import contribute from '../server/plugin.ts';

const remove = vi.fn();
let sdk: FakePaseo;
vi.mock('@getpaseo/client', () => ({ createPaseoClient: () => ({
  connect: async () => {}, close: async () => {}, hosts: { remove, list: async () => ({ self: { serverId: FAKE_SERVER_ID, label: 'Local' }, hosts: [] }) },
}) }));
vi.mock('../server/route.ts', () => ({
  optionalFileCounter: () => async () => 0, openSource: async () => ({ sdk }),
}));
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function prepare() {
  const dir = mkdtempSync(join(tmpdir(), 'plugin-lifecycle-'));
  dirs.push(dir);
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('expected a TCP port');
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const daemon = join(dir, 'daemon');
  const conf = join(dir, 'paseo-task-manager', FAKE_SERVER_ID);
  mkdirSync(daemon);
  mkdirSync(join(dir, 'data'));
  mkdirSync(conf, { recursive: true });
  writeFileSync(join(daemon, 'config.json'), '{}');
  writeFileSync(join(daemon, 'paseo.pid'), JSON.stringify({ listen: '127.0.0.1:6767' }));
  writeFileSync(join(daemon, 'server-id'), FAKE_SERVER_ID);
  vi.stubEnv('PASEO_HOME', daemon);
  vi.stubEnv('XDG_CONFIG_HOME', dir);
  vi.stubEnv('XDG_STATE_HOME', join(dir, 'state'));
  vi.stubGlobal('CHECKOUT_WEB_DIR', dir);
  writeFileSync(join(conf, 'config.json'), JSON.stringify({ ...config, port: address.port, dbPath: join(dir, 'data', 'center.db'), understanding: { enabled: false } }));
  return `http://127.0.0.1:${address.port}/status`;
}

test('Reloading the contribution releases the previous listener, subscriptions and timers.', async () => {
  const endpoint = await prepare();
  const unsubscribe = vi.fn();
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
});

test('Deselecting the host stops its collector and preserves the registration.', async () => {
  await prepare();
  sdk = new FakePaseo();
  const closed = vi.spyOn(sdk, 'close');
  let deselect = () => {};
  const cleanup = contribute({
    registerSettings: definition => ({
      read: async () => ({ status: 'ready', revision: '', values: definition.schema.parse({ selectedHosts: [FAKE_SERVER_ID] }) }),
      subscribe: listener => {
        deselect = () => { void listener({ status: 'ready', revision: '', values: definition.schema.parse({}) }); };
        return () => {};
      },
    }),
    handle: () => {},
  });
  try {
    await vi.waitFor(() => expect(sdk.status).toBe('connected'));
    deselect();
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(remove).not.toHaveBeenCalled();
  } finally {
    await cleanup();
  }
});
