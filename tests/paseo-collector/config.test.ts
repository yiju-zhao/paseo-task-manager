import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { readConfig } from '../../server/config.ts';
import { PaseoCollectorConfig } from '../../server/collector/config.ts';

afterEach(() => vi.unstubAllEnvs());

test('deployment config resolves token paths and rejects duplicate or unsafe source bindings', () => {
  const dir = mkdtempSync(join(tmpdir(),'task-manager-cfg-'));
  const path = join(dir,'config.json');
  vi.stubEnv('AGENT_PM_PASEO_PLUGIN_CONFIG',path);
  const source = { serverId:'srv_1',sourceId:'paseo-a',machine:'a',tokenFile:'~/.config/source.token' };
  const config = {daemonUrl:'ws://127.0.0.1:6001/ws',daemonServerId:'srv_1',centerUrl:'http://127.0.0.1:6002',stateRoot:join(dir,'state'),sources:[source]};
  try {
    writeFileSync(path,JSON.stringify(config));
    expect(readConfig().sources[0].tokenFile).toBe(join(homedir(),'.config/source.token'));
    writeFileSync(path,JSON.stringify({...config,sources:[source,source]}));
    expect(readConfig).toThrow(/duplicate/);
    writeFileSync(path,JSON.stringify({...config,sources:[{...source,sourceId:'../outside'}]}));
    expect(readConfig).toThrow();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('worker schema retains upstream defaults and bounds', () => {
  const input = {sourceId:'paseo-a',machine:'a',server:'http://localhost',tokenFile:'/test',paseo:{serverId:'srv',url:'ws://localhost/ws'},stateDir:'~/state'};
  expect(PaseoCollectorConfig.parse(input)).toMatchObject({heartbeatMs:10000,reconcileMs:60000,maxConcurrentAgents:4,stateDir:join(homedir(),'state')});
  expect(PaseoCollectorConfig.safeParse({...input,pageLimit:0}).success).toBe(false);
});
