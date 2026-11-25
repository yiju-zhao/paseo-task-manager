import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { pluginPaths } from '../../server/config.ts';
import { PaseoCollectorConfig } from '../../server/collector/config.ts';

afterEach(() => vi.unstubAllEnvs());

test('The plugin resolves host-specific paths and reads the local daemon endpoint.', () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-manager-cfg-'));
  const daemon = join(dir, 'daemon');
  mkdirSync(daemon);
  vi.stubEnv('XDG_CONFIG_HOME', dir);
  try {
    writeFileSync(join(daemon, 'server-id'), 'srv_fixture');
    writeFileSync(join(daemon, 'config.json'), '{}');
    writeFileSync(join(daemon, 'paseo.pid'), JSON.stringify({ serverId: 'srv_fixture', listen: '0.0.0.0:6767' }));
    expect(pluginPaths(daemon)).toMatchObject({
      daemonUrl: 'ws://127.0.0.1:6767/ws', configPath: join(dir, 'paseo-task-manager', 'srv_fixture', 'config.json'),
    });
    vi.stubEnv('XDG_STATE_HOME', daemon);
    expect(() => pluginPaths(daemon)).toThrow(/inside daemon home/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('The worker schema retains upstream defaults and bounds.', () => {
  const input = { sourceId: 'paseo-a', machine: 'a', paseo: { serverId: 'srv', url: 'ws://localhost/ws' }, stateDir: '~/state' };
  expect(PaseoCollectorConfig.parse(input)).toMatchObject({
    heartbeatMs: 10000, reconcileMs: 60000, maxConcurrentAgents: 4, stateDir: join(homedir(), 'state'),
  });
  expect(PaseoCollectorConfig.safeParse({ ...input, pageLimit: 0 }).success).toBe(false);
});
