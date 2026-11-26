import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { startCenter, type RunningCenter } from '../../src/server/center.ts';
import { Settings } from '../../src/server/settings.ts';
import { TICK_MS } from '../../src/understand/scheduler.ts';
import { config } from '../../tests/helpers/center.ts';
import { modelSettings } from '../shared/models.ts';
import { manageModels } from '../server/models.ts';

let dir: string;
let center: RunningCenter;
const log = vi.fn();
const runner = vi.fn(async () => ({ ok: false as const, kind: 'rate_limit' as const, message: 'fixture', durationMs: 1 }));

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  dir = mkdtempSync(join(tmpdir(), 'model-settings-'));
  const file = join(dir, 'config-oauth');
  writeFileSync(file, 'fixture-config-secret');
  center = await startCenter({ config: { ...config, port: 0, dbPath: ':memory:', understanding: { enabled: true, oauthTokenFile: file } },
    configDir: dir, webDir: dir, log, runner });
});

afterEach(async () => {
  await center.stop();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.clearAllMocks();
});

test('The next curator run uses the custom model saved through the settings handler.', async () => {
  manageModels(center, { change: { kind: 'model', role: 'curate', model: 'custom-curator' } });
  const at = new Date(Date.now() - 3600_000).toISOString();
  center.db.prepare(`INSERT INTO digests(session_key,chunk_ids,json,ts_start,ts_end,backfill,trivial,skipped,curated,created_at)
    VALUES ('claude:fixture','[]','{}',?,?,0,0,0,0,?)`).run(at, at, at);
  await vi.advanceTimersByTimeAsync(TICK_MS);
  expect(runner).toHaveBeenCalledWith(expect.objectContaining({ role: 'curate', model: 'custom-curator' }));
  const state = manageModels(center, {});
  expect(state.pause_reason).toContain('限流');
  expect(Date.parse(state.paused_until!)).toBeGreaterThan(Date.now());
});

test('Selecting an API key stores it privately and returns only its suffix.', () => {
  const secret = 'synthetic-provider-secret-abcd';
  const response = modelSettings.output.parse(manageModels(center, { change: { kind: 'provider', mode: 'api_key', secret } }));
  const path = join(dir, 'secrets', 'anthropic-api-key');
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readFileSync(path, 'utf8').trim()).toBe(secret);
  expect(response.provider).toEqual({ mode: 'api_key', origin: 'settings', stored: { api_key: 'abcd' } });
  expect(JSON.stringify([response, manageModels(center, {}), log.mock.calls])).not.toContain(secret);
});

test('Choosing a missing stored OAuth token leaves the current login active.', () => {
  manageModels(center, { change: { kind: 'provider', mode: 'login' } });
  expect(() => manageModels(center, { change: { kind: 'provider', mode: 'oauth_token' } })).toThrow(/no OAuth token/);
  expect(manageModels(center, {}).provider).toMatchObject({ mode: 'login', origin: 'settings' });
});

test('Reading settings reports configured credentials, each effective model and seven-day call and failure counts.', () => {
  const add = center.db.prepare('INSERT INTO llm_runs(role,ok,ts) VALUES(?,?,?)');
  add.run('digest', 1, new Date().toISOString());
  add.run('digest', 0, new Date().toISOString());
  add.run('restage', 0, new Date(Date.now() - 8 * 86400_000).toISOString());
  const state = modelSettings.output.parse(manageModels(center, {}));
  expect(state.provider).toMatchObject({ mode: 'oauth_token', origin: 'config' });
  expect(state.paused_until).toBeNull();
  expect(state.roles).toMatchObject([
    { role: 'digest', model: center.settings.models().digest, calls: 2, failures: 1 },
    { role: 'curate', model: center.settings.models().curate, calls: 0, failures: 0 },
    { role: 'restage', model: center.settings.models().restage, calls: 0, failures: 0 },
  ]);
  expect(state.model_options).toEqual(center.settings.view().model_options);
});

test('The reported source follows the config token when a previously stored OAuth credential disappears.', () => {
  manageModels(center, { change: { kind: 'provider', mode: 'oauth_token', secret: 'synthetic-oauth-token-for-fixture' } });
  rmSync(join(dir, 'secrets', 'anthropic-oauth-token'));
  expect(manageModels(center, {}).provider).toMatchObject({ mode: 'oauth_token', origin: 'config', stored: {} });
});

test('The steward starts with Opus and keeps its chosen Claude model across settings reads.', () => {
  expect(manageModels(center, {}).steward).toEqual({ provider: 'claude', model: 'claude-opus-5-5' });
  manageModels(center, { change: { kind: 'steward', provider: 'claude', model: 'claude-sonnet-5-5' } });
  const settings = new Settings(center.db, config, null);
  expect(settings.stewardModel()).toEqual({ provider: 'claude', model: 'claude-sonnet-5-5' });
});
test('A model update cannot select a provider with command execution for the steward.', () => {
  expect(modelSettings.input.safeParse({ change: { kind: 'steward', provider: 'codex', model: 'example' } }).success).toBe(false);
});
