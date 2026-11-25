import { afterEach, beforeEach, expect, test } from 'vitest';
import { agent, event, PaseoWriter, startCenter } from '../helpers/center.ts';
import { ToolStorage } from '../../src/server/tool-storage.ts';
import { readItem, readTurn } from '../../src/context/read.ts';
import { readTools } from '../../src/mcp/read-tools.ts';
import { createApp } from '../../src/server/http.ts';
import { defaultDeps } from '../../src/domain/types.ts';
import { config } from '../helpers/center.ts';
import { searchContext } from '../../src/server/search.ts';

let center: ReturnType<typeof startCenter>;
let db: typeof center.db;
let store: ToolStorage;
beforeEach(() => {
  center = startCenter();
  db = center.db;
  store = new ToolStorage(db);
});
afterEach(async () => { await store.stop(); db.close(); });

function add(key: string, output: string, processed: 'done' | 'refused' | 'pending' | 'unmapped' = 'done', source = 'fixture') {
  const meta = JSON.stringify({ tool: { name: 'shell', input: 'cmd', output, error: null, status: 'completed', exit_code: 0 } });
  const id = Number(db.prepare(`INSERT INTO source_events(source_id,stream_id,base_key,event_key,content_hash,revision,session_key,kind,ts,meta,disposition)
    VALUES (?, 'agent', ?, ?, ?, 1, 'claude:fixture', 'tool','2026-01-01', ?, 'materialized')`).run(source, key, key, source + key, meta).lastInsertRowid);
  if (processed !== 'unmapped') {
    const chunk = db.prepare("INSERT INTO chunks(session_key,kind,offset_start,text,digested,digest_block_id) VALUES ('claude:fixture','transcript',?,'kept',?,?)")
      .run(id, processed === 'done' ? 1 : 0, processed === 'refused' ? 1 : null);
    db.prepare('INSERT INTO chunk_sources VALUES (?,?)').run(chunk.lastInsertRowid, id);
  }
  return id;
}
const retained = () => db.prepare('SELECT id FROM source_events WHERE detail_bytes>0 ORDER BY id').all().map(row => row.id);

test('Eviction clears the oldest processed tool until usage reaches the low-water mark.', async () => {
  const old = add('old', '测'.repeat(20));
  const recent = add('recent', 'x'.repeat(45));
  expect(store.status().used).toBe(111);
  await store.schedule(100);
  expect(retained()).toEqual([recent]);
  const meta = JSON.parse(String(db.prepare('SELECT meta FROM source_events WHERE id=?').get(old)?.meta));
  expect(meta).toMatchObject({ input_preview: 'cmd', tool: { input: '', output: '', error: null, exit_code: 0, name: 'shell' } });
  expect(meta.detail_cleared_at).toBeTruthy();
  expect(db.prepare("SELECT count(*) n FROM chunks WHERE text='kept'").get()?.n).toBe(2);
});

test('Pending chunks survive while later refused and digested tools can be evicted.', async () => {
  const pending = add('pending', 'long', 'pending');
  add('blocked', 'long', 'refused');
  add('done', 'long');
  await store.schedule(2);
  expect(retained()).toEqual([pending]);
  expect(store.status().blocked).toBe(true);
});

test('Unmapped byte-identical copies can use a directly processed version from another source.', async () => {
  add('tool:x', 'same');
  add('tool:x', 'same', 'unmapped', 'other');
  await store.schedule(1);
  expect(retained()).toEqual([]);
});

test('An unmapped version with different output remains intact.', async () => {
  add('tool:x', 'sample');
  const other = add('tool:x', 'sample ', 'unmapped', 'other');
  await store.schedule(1);
  expect(retained()).toEqual([other]);
});

test('Unmapped copies stay when the logical event has no processed version.', async () => {
  const pending = add('tool:x', 'same', 'pending');
  const other = add('tool:x', 'same', 'unmapped', 'other');
  await store.schedule(1);
  expect(retained()).toEqual([pending, other]);
});

test('Previewing a lower cap measures the outcome without changing stored details.', async () => {
  const first = add('one', '12345');
  const last = add('two', '12345');
  const preview = await store.preview(10);
  expect(preview).toMatchObject({ clearBytes: 8, oldest: '2026-01-01' });
  expect(retained()).toEqual([first, last]);
  await store.schedule(10);
  expect(retained()).toEqual([last]);
});

test('A usage below the cap keeps every tool.', async () => {
  const id = add('one', 'small');
  await store.schedule(100);
  expect(retained()).toEqual([id]);
});

test('Conversation messages keep their search entries and consume no tool budget.', async () => {
  const writer = new PaseoWriter(center);
  await writer.lease();
  await writer.snapshot([agent('fixture', { native_id: 'abcdef12', native_id_origin: 'runtime' })]);
  await writer.batch(writer.batchBody('fixture', null, { epoch: 'epoch-1', seq: 1 }, [
    event('msg:fixture', 1, { kind: 'user', text: 'searchable conversation' }),
  ]));
  add('tool', 'huge');
  await store.schedule(1);
  expect(store.status().used).toBe(0);
  expect(db.prepare("SELECT text FROM source_events WHERE kind='user'").get()?.text).toBe('searchable conversation');
  expect(searchContext(db, 'searchable', { scope: 'messages', limit: 5 })).toHaveLength(1);
});

async function evictRealTool() {
  const writer = new PaseoWriter(center);
  await writer.lease();
  await writer.snapshot([agent('fixture', { native_id: 'abcdef12', native_id_origin: 'runtime' })]);
  const tool = event('tool:build', 1, { kind: 'tool', item_type: 'tool_call', text: '',
    tool: { name: 'shell', input: '测'.repeat(250), output: 'result', error: null, status: 'completed', exit_code: 0,
      input_truncated: null, output_truncated: null } });
  await writer.batch(writer.batchBody('fixture', null, { epoch: 'epoch-1', seq: 1 }, [tool]));
  db.exec('UPDATE chunks SET digested=1');
  await store.schedule(10);
  return { writer, tool };
}

test('Evicted tools retain exactly 200 input characters in the turn outline.', async () => {
  await evictRealTool();
  expect(readTurn(db, 'abcdef12', 1).items[0].tool?.input).toBe('测'.repeat(200));
  expect(readItem(db, 'abcdef12', 1, 1, { offset: 0 }).text).toContain('已清除');
});

test('Replaying an evicted event in a new epoch does not reinsert its bytes.', async () => {
  const { writer, tool } = await evictRealTool();
  const sent = await writer.batch(writer.batchBody('fixture', { epoch: 'epoch-1', seq: 1 }, { epoch: 'epoch-2', seq: 1 },
    [{ ...tool, epoch: 'epoch-2', ts: new Date().toISOString() }], { reset: { previous_epoch: 'epoch-1', reason: 'replacement' } }));
  expect(sent.status).toBe(200);
  expect(db.prepare('SELECT count(*) n FROM source_events').get()?.n).toBe(1);
  expect(store.status().used).toBe(0);
});

test('The evidence drawer endpoint resolves evicted tools through the explicit reader.', async () => {
  await evictRealTool();
  const app = createApp(db, config, undefined, undefined, { upstream: async () => ({ text: 'recovered evidence' }) });
  const response = await app.request('/evidence/s:abcdef12%231', { headers: { authorization: 'Bearer ' + config.userToken } });
  expect(await response.json()).toMatchObject({ turn: { items: [{ detail: 'recovered evidence' }] } });
});

test('The overview suggests raising the cap when remaining tools cannot be cleared.', async () => {
  add('pending', 'input', 'pending');
  await store.schedule(1);
  const tools = readTools(db, defaultDeps(), 'fixture', { config, startedAt: center.now, toolUsage: () => store.status() });
  expect((await tools.find(tool => tool.name === 'pm_overview')!.handler({})).text).toContain('请调高上限');
});
