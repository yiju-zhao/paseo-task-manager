import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { ServerConfig } from '../../src/server/config.ts';
import { openDb } from '../../src/server/db.ts';
import { openPluginDatabase, pluginConfig } from '../server/database.ts';

let dir: string;
let paths: { configPath: string; stateRoot: string; daemonHome: string };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plugin-db-'));
  paths = { configPath: join(dir, 'config', 'config.json'), stateRoot: join(dir, 'state'), daemonHome: join(dir, 'daemon') };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const record = () => JSON.parse(readFileSync(join(dirname(paths.configPath), 'database.json'), 'utf8')) as { id: string; path: string };
function configure(path: string) {
  const config = pluginConfig(paths);
  writeFileSync(paths.configPath, JSON.stringify({ ...config, listen: 'localhost', dbPath: path }));
  return pluginConfig(paths);
}

test('First startup writes a private loopback configuration with distinct valid tokens.', () => {
  const cfg = pluginConfig(paths);
  expect(ServerConfig.parse(cfg)).toMatchObject({ listen: '127.0.0.1', port: 7718, collectors: {} });
  expect(cfg.userToken).not.toBe(cfg.mcpToken);
  expect(statSync(dirname(paths.configPath)).mode & 0o777).toBe(0o700);
  expect(statSync(paths.configPath).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(paths.configPath, 'utf8'))).not.toHaveProperty('dbPath');
  expect(pluginConfig(paths)).toEqual(cfg);
});

test('The default database and its separate identity file have private permissions.', () => {
  const cfg = pluginConfig(paths);
  openPluginDatabase(paths, cfg.dbPath, false).close();
  expect(record()).toMatchObject({ path: join(paths.stateRoot, 'task-manager.db') });
  expect(statSync(paths.stateRoot).mode & 0o777).toBe(0o700);
  expect(statSync(cfg.dbPath).mode & 0o777).toBe(0o600);
  expect(statSync(join(dirname(paths.configPath), 'database.json')).mode & 0o777).toBe(0o600);
});

test('An existing matching database keeps its identity on restart.', () => {
  const cfg = pluginConfig(paths);
  openPluginDatabase(paths, cfg.dbPath, false).close();
  const before = record();
  openPluginDatabase(paths, cfg.dbPath, false).close();
  expect(record()).toEqual(before);
});

test('A missing recorded database requires confirmation before creating a replacement.', () => {
  const cfg = pluginConfig(paths);
  openPluginDatabase(paths, cfg.dbPath, false).close();
  const before = record();
  renameSync(cfg.dbPath, cfg.dbPath + '.moved');
  expect(() => openPluginDatabase(paths, cfg.dbPath, false)).toThrow(/不存在/);
  expect(existsSync(cfg.dbPath)).toBe(false);
  openPluginDatabase(paths, cfg.dbPath, true).close();
  expect(record().id).not.toBe(before.id);
});

test('A different database stays untouched even when a stale client requests a fresh start.', () => {
  const cfg = pluginConfig(paths);
  openPluginDatabase(paths, cfg.dbPath, false).close();
  const before = record();
  const otherPaths = { ...paths, configPath: join(dir, 'other-config', 'config.json'), stateRoot: join(dir, 'other-state') };
  const other = pluginConfig(otherPaths);
  openPluginDatabase(otherPaths, other.dbPath, false).close();
  renameSync(other.dbPath, cfg.dbPath);
  const bytes = readFileSync(cfg.dbPath);
  const files = readdirSync(paths.stateRoot);
  for (const fresh of [false, true]) {
    let error;
    try { openPluginDatabase(paths, cfg.dbPath, fresh).close(); } catch (err) { error = err; }
    expect(error).toMatchObject({ canStartFresh: false });
    expect(String(error)).toContain(before.id);
  }
  expect(readFileSync(cfg.dbPath).equals(bytes)).toBe(true);
  expect(readdirSync(paths.stateRoot)).toEqual(files);
  expect(record()).toEqual(before);
});

test('An explicitly configured missing parent directory is never created.', () => {
  const path = join(dir, 'absent', 'center.db');
  expect(() => configure(path)).toThrow();
  expect(existsSync(dirname(path))).toBe(false);
});

test('An existing center database gets an identity while preserving its rows.', () => {
  const data = join(dir, 'data');
  mkdirSync(data);
  const cfg = configure(join(data, 'existing.db'));
  expect(cfg.listen).toBe('localhost');
  const legacy = openDb(cfg.dbPath);
  legacy.exec('CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES (\'keep\')');
  legacy.close();
  const db = openPluginDatabase(paths, cfg.dbPath, false);
  try { expect(db.prepare('SELECT value FROM fixture').get()).toEqual({ value: 'keep' }); } finally { db.close(); }
  expect(record().id).toBeTruthy();
});
