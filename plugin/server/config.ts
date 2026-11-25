import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { z } from 'zod';

function diskPath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  return join(diskPath(dirname(path)), basename(path));
}

export function checkStoragePath(path: string, daemonHome: string) {
  const state = diskPath(resolve(path));
  const daemon = diskPath(resolve(daemonHome));
  if (state === daemon || state.startsWith(daemon + sep)) throw new Error('storage path is inside daemon home');
  for (let dir = state; dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, 'paseo-plugin.json')) || (existsSync(join(dir, 'daemon-keypair.json')) && existsSync(join(dir, 'server-id')))) {
      throw new Error('storage path is inside a plugin installation or daemon home');
    }
  }
}

export function pluginPaths(daemonHome = process.env.PASEO_HOME ?? join(homedir(), '.paseo')) {
  const serverId = z.string().regex(/^[\w-]+$/).parse(readFileSync(join(daemonHome, 'server-id'), 'utf8').trim());
  // During daemon startup the pid file exists before the listener has published its address.
  const runtime = JSON.parse(readFileSync(join(daemonHome, 'paseo.pid'), 'utf8')) as { listen?: string | null };
  const persisted = JSON.parse(readFileSync(join(daemonHome, 'config.json'), 'utf8')) as { daemon?: { listen?: string } };
  const url = new URL('ws://' + (runtime.listen ?? persisted.daemon?.listen ?? '127.0.0.1:6767'));
  if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
  if (url.hostname === '[::]') url.hostname = '[::1]';
  url.pathname = '/ws';
  const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const stateHome = process.platform === 'win32' ? process.env.LOCALAPPDATA! : process.env.XDG_STATE_HOME || join(homedir(), '.local/state');
  const configPath = join(configHome, 'paseo-task-manager', serverId, 'config.json');
  const stateRoot = join(stateHome, 'paseo-task-manager', serverId);
  checkStoragePath(stateRoot, daemonHome);
  checkStoragePath(configPath, daemonHome);
  return { daemonHome, daemonServerId: serverId, daemonUrl: url.href, configPath, stateRoot };
}
