import { afterEach, beforeEach, expect, test } from 'vitest';
import { readOverview } from '../../src/context/read.ts';
import { SOURCE_REMINDER_AFTER_MS } from '../../src/domain/reminders.ts';
import { createApp } from '../../src/server/http.ts';
import { call, config, HERDR_TOKEN, herdrChunks, herdrSession, herdrSnapshot, startCenter, type Center } from '../helpers/center.ts';

let center: Center;
const sourceConfig = { ...config, paseoHostSelection: () => ({ selected: ['selected'], total: 2 }) };
beforeEach(async () => {
  center = startCenter();
  await call(center, 'POST', '/ingest/snapshot', HERDR_TOKEN, herdrSnapshot([herdrSession('claude:historical')]));
  center.app = createApp(center.db, config, () => center.now, undefined, { plugin: { paseoHostSelection: sourceConfig.paseoHostSelection } });
});
afterEach(() => center.close());

test('Only selected registered Paseo sources appear in coverage, blind spots and offline reminders.', async () => {
  const add = center.db.prepare(`INSERT INTO ingest_sources(source_id, kind, machine, server_id, collector_heartbeat)
    VALUES (?, 'paseo', 'fixture', ?, ?)`);
  for (const host of ['selected', 'removed', 'unselected']) add.run('paseo-' + host, host, center.now.toISOString());
  center.advance(SOURCE_REMINDER_AFTER_MS + 1);
  const coverage = await call(center, 'GET', '/coverage', config.userToken);
  expect(coverage.json.map((s: { source_id: string }) => s.source_id)).toEqual(['paseo-selected']);
  const overview = readOverview(center.db, center.now, 'fixture', { config: sourceConfig, startedAt: center.now });
  expect(overview.sources).toMatchObject([{ id: 'paseo-selected', state: 'offline' }]);
  const reminders = await call(center, 'GET', '/reminders', config.userToken);
  expect(reminders.json.filter((r: { category: string }) => r.category === 'source_offline')
    .map((r: { key: string }) => r.key)).toEqual(['source:paseo-selected']);
});

test('The plugin rejects legacy herdr ingest before processing bodies or accessing the database.', async () => {
  const before = center.db.prepare('SELECT total_changes() n').get();
  const responses = [
    await call(center, 'POST', '/ingest/snapshot', HERDR_TOKEN, herdrSnapshot([herdrSession('claude:new')])),
    await call(center, 'POST', '/ingest/chunks', HERDR_TOKEN, herdrChunks('claude:historical', 1, 2)),
    await call(center, 'GET', '/ingest/offset?machine=fixture&session_key=claude:historical', HERDR_TOKEN),
  ];
  expect(responses.map(r => [r.status, r.json.error])).toEqual(Array(3).fill([410, 'herdr_ingest_disabled']));
  expect(center.db.prepare('SELECT total_changes() n').get()).toEqual(before);
  expect((await center.app.request('/sessions')).status).toBe(200);
  expect(await (await center.app.request('/sessions')).text()).toContain('claude:historical');
});

test('Blind-spot totals follow session observations even when herdr delivered the pending text.', () => {
  const db = center.db;
  const addSource = db.prepare("INSERT INTO ingest_sources(source_id,kind,machine,server_id) VALUES (?, 'paseo', 'fixture', ?)");
  const observe = db.prepare('INSERT INTO session_sources(source_id,external_id,session_key) VALUES (?,?,?)');
  const chunk = db.prepare("INSERT INTO chunks(session_key,source_id,text,digested) VALUES (?, 'herdr:fixture', 'pending', 0)");
  const block = db.prepare("INSERT INTO digest_blocks(session_key,chunk_ids,message,created_at) VALUES (?, '[]', 'refused', ?)");
  for (const host of ['selected', 'unselected']) {
    addSource.run('paseo-' + host, host);
    observe.run('paseo-' + host, host, 'claude:' + host);
  }
  for (const key of ['claude:selected', 'claude:unselected', 'claude:historical']) {
    chunk.run(key);
    block.run(key, center.now.toISOString());
  }
  expect(readOverview(db, center.now, 'fixture', { config: sourceConfig, startedAt: center.now })).toMatchObject({ undigested: 1, refusals: 1 });
  expect(readOverview(db, center.now, 'fixture')).toMatchObject({ undigested: 3, refusals: 3 });
});
