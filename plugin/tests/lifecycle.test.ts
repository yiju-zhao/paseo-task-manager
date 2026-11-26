import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { openDb } from '../../src/server/db.ts';
import { config } from '../../tests/helpers/center.ts';
import { FakePaseo, FAKE_SERVER_ID } from './helpers/fake-paseo.ts';
import contribute from '../server/plugin.ts';

const remove = vi.fn();
const remoteHosts: { serverId: string; label: string; enabled: boolean; status: string }[] = [];
let sdk: FakePaseo;
vi.mock('@getpaseo/client', () => ({ createPaseoClient: () => ({
  connect: async () => {}, close: async () => {}, hosts: { remove, list: async () => ({ self: { serverId: FAKE_SERVER_ID, label: 'Local' }, hosts: remoteHosts }) },
}) }));
vi.mock('../server/route.ts', () => ({
  optionalFileCounter: () => async () => 0, openSource: async () => ({ sdk }),
}));
const dirs: string[] = [];
afterEach(() => {
  remoteHosts.length = 0;
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
  writeFileSync(join(conf, 'config.json'), JSON.stringify({ ...config, collectors: undefined, port: address.port, dbPath: join(dir, 'data', 'center.db'), understanding: { enabled: false } }));
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
      handle: () => {}, addHook: () => () => {},
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
    handle: () => {}, addHook: () => () => {},
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

test('A stale selection disappears from coverage when its host leaves the daemon directory.', async () => {
  const endpoint = await prepare();
  const db = openDb(join(dirs[0], 'data', 'center.db'));
  db.prepare("INSERT INTO ingest_sources(source_id,kind,machine,server_id) VALUES ('old','paseo','fixture','removed')").run();
  db.close();
  remoteHosts.push({ serverId: 'registered', label: 'fixture', enabled: true, status: 'offline' });
  const cleanup = contribute({
    registerSettings: definition => ({
      read: async () => ({ status: 'ready', revision: '', values: definition.schema.parse({ selectedHosts: ['removed', 'registered'] }) }),
      subscribe: () => () => {},
    }),
    handle: () => {}, addHook: () => () => {},
  });
  try {
    await vi.waitFor(async () => {
      const res = await fetch(new URL('/coverage', endpoint), { headers: { authorization: 'Bearer ' + config.userToken } });
      expect(await res.json()).toMatchObject([{ source_id: 'paseo-fixture' }]);
    });
  } finally {
    await cleanup();
  }
});

test.each([
  { scenario: 'none selected', selectedHosts: [], first: "还没有打开任何机器的采集，在插件设置的'机器'一节打开", last: '另有 2 台机器未打开采集' },
  { scenario: 'one selected', selectedHosts: [FAKE_SERVER_ID], first: '', last: '另有 1 台机器未打开采集' },
  { scenario: 'all selected', selectedHosts: [FAKE_SERVER_ID, 'remote'], first: '', last: '' },
])('The overview describes host coverage with $scenario.', async ({ selectedHosts, first, last }) => {
  const endpoint = await prepare();
  sdk = new FakePaseo();
  remoteHosts.push({ serverId: 'remote', label: 'Remote', enabled: true, status: 'offline' });
  const cleanup = contribute({
    registerSettings: definition => ({
      read: async () => ({ status: 'ready', revision: '', values: definition.schema.parse({ selectedHosts }) }),
      subscribe: () => () => {},
    }),
    handle: () => {}, addHook: () => () => {},
  });
  try {
    await vi.waitFor(async () => {
      const response = await fetch(new URL('/mcp', endpoint), {
        method: 'POST',
        headers: { authorization: 'Bearer ' + config.mcpToken, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pm_overview', arguments: {} } }),
      });
      const result = await response.json() as { result: { content: { text: string }[] } };
      const blindSpots = result.result.content[0].text.split('\n\n')[0];
      if (first) {
        expect(blindSpots.split('\n')[1]).toBe('- ' + first);
        expect(blindSpots).not.toContain('个来源正常');
      } else {
        expect(blindSpots).not.toContain('还没有打开任何机器的采集');
        expect(blindSpots).toContain('1 个来源正常');
      }
      if (last) expect(blindSpots.split('\n').at(-1)).toBe('- ' + last);
      else {
        expect(blindSpots).toContain('paseo-remote');
        expect(blindSpots).not.toContain('台机器未打开采集');
      }
    });
  } finally {
    await cleanup();
  }
});
