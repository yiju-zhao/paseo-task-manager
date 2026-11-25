import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { expandHome } from './paths.ts';
import { MachineLabel } from './protocol/protocol.ts';

const absolute = z.string().min(1).transform(p => expandHome(p)).refine(isAbsolute, 'must be absolute');
const schema = z.object({
  daemonUrl: z.url({ protocol: /^wss?$/ }),
  daemonServerId: z.string().min(1),
  centerUrl: z.url({ protocol: /^https?$/ }),
  stateRoot: absolute.default(join(homedir(), '.local/state/agent-pm-paseo-plugin')),
  sources: z.array(z.object({
    serverId: z.string().min(1),
    sourceId: z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/),
    machine: MachineLabel, tokenFile: absolute,
  })).min(1),
});
export type Config = z.output<typeof schema>;
export type Source = Config['sources'][number];

// Resolve symlinked existing ancestors as well as a state directory that has not been created yet.
function diskPath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  return join(diskPath(dirname(path)), basename(path));
}

export function readConfig(): Config {
  const path = process.env.AGENT_PM_PASEO_PLUGIN_CONFIG ?? join(homedir(), '.config/agent-pm-paseo-plugin/config.json');
  const cfg = schema.parse(JSON.parse(readFileSync(path, 'utf8')));
  for (const field of ['serverId','sourceId'] as const) {
    if (new Set(cfg.sources.map(s => s[field])).size !== cfg.sources.length) throw new Error('duplicate ' + field);
  }
  const state = diskPath(resolve(cfg.stateRoot));
  const daemon = diskPath(resolve(process.env.PASEO_HOME ?? join(homedir(), '.paseo')));
  if (state === daemon || state.startsWith(daemon + sep)) throw new Error('stateRoot is inside daemon home');
  for (let dir = state; dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, 'paseo-plugin.json')) || (existsSync(join(dir, 'daemon-keypair.json')) && existsSync(join(dir, 'server-id')))) {
      throw new Error('stateRoot is inside a plugin installation or daemon home');
    }
  }
  return cfg;
}
