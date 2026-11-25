import { serve } from '@hono/node-server';
import { readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { defaultDeps } from '../domain/types.ts';
import { exclusiveLock } from '../shared/exclusive-lock.ts';
import { agentSdkRunner } from '../understand/agent-sdk.ts';
import { jevDecider } from '../understand/decider.ts';
import type { LlmRunner } from '../understand/llm.ts';
import { Scheduler } from '../understand/scheduler.ts';
import { disabledStatus } from '../understand/status.ts';
import { ChangeFeed } from './change-feed.ts';
import { understandingSettings, type ServerConfig } from './config.ts';
import { openDb } from './db.ts';
import { createApp, type AppOptions } from './http.ts';
import { Settings } from './settings.ts';
import { attachStream } from './stream.ts';

export type CenterOptions = {
  config: ServerConfig & { dbPath: string };
  configDir: string;
  webDir: string;
  log: (line: string) => void;
  runner?: LlmRunner;
  upstream?: AppOptions['upstream'];
  openDatabase?: typeof openDb;
};

export type RunningCenter = { db: DatabaseSync; port: number; stop(): Promise<void> };

function readTokenFile(path: string): string {
  let token: string;
  try {
    token = readFileSync(path, 'utf8').trim();
  } catch (err) {
    throw new Error(`cannot read understanding.oauthTokenFile ${path}: ${(err as Error).message}`, { cause: err });
  }
  if (!token) throw new Error(`understanding.oauthTokenFile ${path} is empty`);
  return token;
}

export async function startCenter({ config, configDir, webDir, log, runner, upstream, openDatabase = openDb }: CenterOptions): Promise<RunningCenter> {
  const understanding = understandingSettings(config);
  if (understanding.enabled && understanding.oauthTokenFile) readTokenFile(understanding.oauthTokenFile);
  let guard: DatabaseSync | undefined;
  let db: DatabaseSync | undefined;
  try {
    if (config.dbPath !== ':memory:') {
      const lock = config.dbPath + '.writer';
      guard = exclusiveLock(lock, () => 'database in use by ' + readFileSync(lock + '.owner', 'utf8'));
      const started = new Date(Date.now() - process.uptime() * 1000).toISOString();
      writeFileSync(lock + '.owner', `pid ${process.pid}, started ${started}`, { mode: 0o600 });
    }
    const database = openDatabase(config.dbPath);
    db = database;
    const settings = new Settings(database, config, join(configDir, 'secrets'));
    let scheduler: Scheduler | null = null;
    let mergeLlm = null;
    if (understanding.enabled) {
      const llm = runner ?? agentSdkRunner({ credential: () => settings.credential() });
      const key = config.understanding?.jevKeyFile;
      const decider = key ? jevDecider({ key: readTokenFile(key), baseUrl: process.env.TYPESAFE_BASE_URL,
        model: process.env.TYPESAFE_DEFAULT_MODEL }) : undefined;
      if (decider) log('agent-pm server: questions that need no user are decided by TypeSafe Jev');
      scheduler = new Scheduler(database, defaultDeps(), llm, () => settings.models(), decider);
      mergeLlm = { runner: llm, model: () => settings.models().curate };
      if (settings.credential().mode === 'login' && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
        log("agent-pm server: no understanding.oauthTokenFile and no CLAUDE_CODE_OAUTH_TOKEN; model calls use this machine's Claude Code login");
      }
    }
    const app = createApp(database, config, undefined, undefined, { scheduler, webDir, settings, mergeLlm, upstream });
    const feed = new ChangeFeed(database, { status: () => scheduler?.status() ?? disabledStatus() });
    const server = serve({ fetch: app.fetch, port: config.port, hostname: config.listen });
    const stream = attachStream(server as Server, feed);
    let address;
    try {
      address = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.once('listening', () => {
          server.off('error', reject);
          const bound = server.address();
          if (bound && typeof bound !== 'string') resolve(bound.port);
        });
      });
    } catch (err) {
      stream.close();
      feed.stop();
      throw err;
    }
    scheduler?.start();
    log(`agent-pm server: listening on :${address} (${config.listen ?? 'all interfaces'}), db ${config.dbPath}, ${Object.keys(config.collectors).length} collector(s)`);
    let stopping: Promise<void> | undefined;
    async function shutdown() {
      stream.close();
      feed.stop();
      const closed = new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
      if (scheduler?.status().running) log('agent-pm server: waiting for the running model call to finish…');
      try {
        await Promise.all([closed, scheduler?.stop()]);
      } finally {
        database.close();
        guard?.close();
      }
    }
    return { db: database, port: address, stop: () => stopping ??= shutdown() };
  } catch (err) {
    db?.close();
    guard?.close();
    throw err;
  }
}
