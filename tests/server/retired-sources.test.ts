import { afterEach, beforeEach, expect, test } from 'vitest';
import { defaultDeps } from '../../src/domain/types.ts';
import { listReminders, SOURCE_REMINDER_AFTER_MS } from '../../src/domain/reminders.ts';
import { readTools } from '../../src/mcp/read-tools.ts';
import { sourceCoverage } from '../../src/server/coverage.ts';
import { setSourceRetired } from '../../src/server/sources-repo.ts';
import { agent, call, config, event, HERDR_TOKEN, herdrChunks, herdrSession, herdrSnapshot, MACHINE,
  PaseoWriter, PASEO_SOURCE, startCenter, type Center } from '../helpers/center.ts';

let center: Center;
const source = 'herdr:' + MACHINE;
const key = 'claude:fixture';
beforeEach(async () => {
  center = startCenter();
  await call(center, 'POST', '/ingest/snapshot', HERDR_TOKEN, herdrSnapshot([herdrSession(key)]));
  center.advance(SOURCE_REMINDER_AFTER_MS + 1);
});
afterEach(() => center.close());

function offlineReminder() {
  return listReminders(center.db, center.now, { config, startedAt: center.now }).some(r => r.key === 'source:' + source);
}

test('The overview counts a retired source separately from offline and healthy sources.', async () => {
  setSourceRetired(center.db, source, true, center.now);
  const tools = readTools(center.db, { ...defaultDeps(), now: () => center.now }, 'fixture', { config, startedAt: center.now });
  const overview = await tools.find(tool => tool.name === 'pm_overview')!.handler({});
  expect(overview.text).toContain('已退役 1 个');
  expect(overview.text).not.toContain(source);
  expect(sourceCoverage(center.db, config, center.now).find(row => row.source_id === source)?.state).toBe('retired');
});

test('Retiring an offline source suppresses its reminder until the next reporting cycle.', async () => {
  expect(offlineReminder()).toBe(true);
  setSourceRetired(center.db, source, true, center.now);
  expect(offlineReminder()).toBe(false);
  await call(center, 'POST', '/ingest/snapshot', HERDR_TOKEN, herdrSnapshot([herdrSession(key)]));
  expect(offlineReminder()).toBe(false);
  center.advance(SOURCE_REMINDER_AFTER_MS + 1);
  expect(offlineReminder()).toBe(true);
});

test('A herdr chunk delivery reactivates a retired source.', async () => {
  setSourceRetired(center.db, source, true, center.now);
  await call(center, 'POST', '/ingest/chunks', HERDR_TOKEN, herdrChunks(key, 1, 2));
  expect(sourceCoverage(center.db, config, center.now).find(row => row.source_id === source)?.state).toBe('ok');
});

test('An accepted Paseo batch reactivates a retired source.', async () => {
  const writer = new PaseoWriter(center);
  await writer.lease();
  await writer.snapshot([agent('fixture')]);
  setSourceRetired(center.db, PASEO_SOURCE, true, center.now);
  const batch = writer.batchBody('fixture', null, { epoch: 'epoch-1', seq: 1 }, [event('msg:fixture', 1)]);
  expect((await writer.batch(batch)).status).toBe(200);
  expect(sourceCoverage(center.db, config, center.now).find(row => row.source_id === PASEO_SOURCE)?.state).toBe('ok');
});

test('Restoring a retired source resumes the normal offline state.', () => {
  setSourceRetired(center.db, source, true, center.now);
  setSourceRetired(center.db, source, false, center.now);
  expect(offlineReminder()).toBe(true);
});

test('Marking an unknown source fails without changing the source directory.', () => {
  const rows = center.db.prepare('SELECT * FROM ingest_sources');
  const before = rows.all();
  expect(() => setSourceRetired(center.db, 'missing', true, center.now)).toThrow(/来源不存在/);
  expect(rows.all()).toEqual(before);
});
