import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { loadServerConfig } from '../../src/server/config.ts';
import { openDb } from '../../src/server/db.ts';
import { writeFileAtomic } from './collector/state-store.ts';
import { checkStoragePath } from './config.ts';

type Paths = { configPath: string; stateRoot: string; daemonHome: string };
const identity = z.object({ id: z.string().min(1), path: z.string(), recordedAt: z.string() });

export class DatabaseProblem extends Error {
  readonly canStartFresh: boolean;
  constructor(message: string, canStartFresh = false) {
    super(message);
    this.canStartFresh = canStartFresh;
  }
}

export function pluginConfig(paths: Paths) {
  const dir = dirname(paths.configPath);
  if (!existsSync(paths.configPath)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, 'config-' + randomUUID() + '.tmp');
    const config = { port: 7718, listen: '127.0.0.1', userToken: randomBytes(32).toString('hex'),
      mcpToken: randomBytes(32).toString('hex'), collectors: {} };
    writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    try {
      linkSync(tmp, paths.configPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    } finally {
      unlinkSync(tmp);
    }
  }
  const config = loadServerConfig(paths.configPath, () => {
    mkdirSync(paths.stateRoot, { recursive: true, mode: 0o700 });
    return join(paths.stateRoot, 'task-manager.db');
  });
  checkStoragePath(config.dbPath, paths.daemonHome);
  if (config.dbPath === ':memory:') throw new DatabaseProblem('插件需要持久化数据库路径');
  if (!existsSync(dirname(config.dbPath))) throw new DatabaseProblem('数据库上级目录不存在：' + dirname(config.dbPath));
  const dbDir = existsSync(config.dbPath) ? dirname(realpathSync(config.dbPath)) : realpathSync(dirname(config.dbPath));
  const configDir = realpathSync(dir);
  if (dbDir === configDir || configDir.startsWith(dbDir + sep)) throw new DatabaseProblem('数据库身份记录必须位于数据库目录之外');
  return config;
}

/** Called while the center holds the writer lock, before migrations or WAL configuration. */
export function openPluginDatabase(paths: Paths, path: string, fresh: boolean): DatabaseSync {
  const file = join(dirname(paths.configPath), 'database.json');
  const saved = existsSync(file) ? identity.parse(JSON.parse(readFileSync(file, 'utf8'))) : undefined;
  const exists = existsSync(path);
  if (!exists) {
    if (existsSync(path + '-wal') || existsSync(path + '-shm')) throw new DatabaseProblem('库文件缺失，但仍有 SQLite 辅助文件：' + path);
    if (saved && !fresh) throw new DatabaseProblem(`数据库不存在：${path}。原库：${saved.path}（${saved.id}）`, true);
    closeSync(openSync(path, 'wx', 0o600));
  } else if (saved) {
    const wal = existsSync(path + '-wal');
    if (wal && !existsSync(path + '-shm')) throw new DatabaseProblem('无法只读核验缺少共享内存文件的 WAL 数据库：' + path);
    const uri = pathToFileURL(path).href + (wal ? '?mode=ro' : '?immutable=1');
    const probe = new DatabaseSync(uri, { readOnly: true });
    let actual: SQLOutputValue | undefined;
    try {
      if (probe.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get()) {
        actual = probe.prepare("SELECT value FROM settings WHERE key='database_id'").get()?.value;
      }
    } finally {
      probe.close();
    }
    if (actual !== saved.id) throw new DatabaseProblem(
      `这不是之前那份库，请把它移走或改用其他路径。之前：${saved.path}（${saved.id}）。当前：${path}（${actual ?? '没有库 ID'}）。`);
  }
  const db = openDb(path);
  try {
    const id = db.prepare("SELECT value FROM settings WHERE key='database_id'").get()?.value ?? randomUUID();
    if (saved?.id !== id || saved.path !== path) {
      const at = new Date().toISOString();
      db.prepare("INSERT OR IGNORE INTO settings(key, value, updated_at) VALUES ('database_id', ?, ?)").run(id, at);
      writeFileAtomic(file, JSON.stringify({ id, path, recordedAt: at }) + '\n');
    }
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
