import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { startCenter, type RunningCenter } from '../../src/server/center.ts';
import { TICK_MS } from '../../src/understand/scheduler.ts';
import { config } from '../helpers/center.ts';

const running: RunningCenter[] = [];
const dirs: string[] = [];
function options() {
  const dir = mkdtempSync(join(tmpdir(), 'center-'));
  dirs.push(dir);
  return { config: { ...config, port: 0, dbPath: join(dir, 'center.db'), understanding: { enabled: false } },
    configDir: dir, webDir: dir, log: () => {} };
}
afterEach(async () => {
  for (const center of running.splice(0)) await center.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test('A running center serves its understanding status.', async () => {
  const center = await startCenter(options());
  running.push(center);
  expect((await fetch(`http://127.0.0.1:${center.port}/status`)).ok).toBe(true);
});

test('Stopping releases the port and database for a new center.', async () => {
  const opts = options();
  const center = await startCenter(opts);
  opts.config.port = center.port;
  await center.stop();
  expect(() => center.db.prepare('SELECT 1')).toThrow();
  const replacement = await startCenter(opts);
  running.push(replacement);
  expect(replacement.port).toBe(center.port);
});

test('A second writer reports the owning process and its start time.', async () => {
  const opts = options();
  running.push(await startCenter(opts));
  await expect(startCenter(opts)).rejects.toThrow(new RegExp(`pid ${process.pid}.*started .*T`));
});

test('Concurrent stops both finish after the same resources are closed.', async () => {
  const opts = options();
  const center = await startCenter(opts);
  await Promise.all([center.stop(), center.stop()]);
  expect(existsSync(opts.config.dbPath)).toBe(true);
});


test('A replacement can open the database after the writer process exits without cleanup.', async () => {
  const opts = options();
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { startCenter } from './src/server/center.ts';
    const options = JSON.parse(process.argv[1]);
    await startCenter({ ...options, log: () => {} });
    process.stdout.write('ready');
  `, JSON.stringify(opts)], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await once(child.stdout, 'data');
  } finally {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  running.push(await startCenter(opts));
});

test('Shutdown waits for a model result to be recorded before closing the database.', async () => {
  const opts = options();
  opts.config.understanding.enabled = true;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const center = await startCenter({ ...opts, runner: async () => {
    entered.resolve();
    await finish.promise;
    return { ok: false, kind: 'auth', message: 'fixture result', durationMs: 1 };
  } });
  try {
    const key = 'claude:fixture';
    const at = new Date(Date.now() - 3600_000).toISOString();
    center.db.prepare(`INSERT INTO sessions
      (key, agent_kind, machine, terminal_id, cwd, title, lifecycle, live_status, ignored, first_seen, last_seen, status_changed_at)
      VALUES (?, 'claude', 'fixture', 'term', '/work', 'task', 'live', 'idle', 0, ?, ?, ?)`).run(key, at, at, at);
    center.db.prepare(`INSERT INTO chunks
      (session_key, kind, offset_start, offset_end, ts_start, ts_end, text, backfill, digested, received_at)
      VALUES (?, 'transcript', 0, 3000, ?, ?, ?, 0, 0, ?)`).run(key, at, at, 'a'.repeat(3000), at);
    await fetch(`http://127.0.0.1:${center.port}/sync`, { method: 'POST', headers: { authorization: 'Bearer ' + config.userToken } });
    vi.advanceTimersByTime(TICK_MS);
    await entered.promise;
    const stopped = center.stop();
    expect(center.db.prepare('SELECT 1').get()).toBeDefined();
    finish.resolve();
    await stopped;
    const db = new DatabaseSync(opts.config.dbPath, { readOnly: true });
    try {
      expect(db.prepare('SELECT error FROM llm_runs').get()).toEqual({ error: 'fixture result' });
    } finally {
      db.close();
    }
  } finally {
    finish.resolve();
    await center.stop();
    vi.useRealTimers();
  }
});
