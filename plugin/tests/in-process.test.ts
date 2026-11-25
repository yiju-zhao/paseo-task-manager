import { afterEach, expect, test } from 'vitest';
import { agent, event, MACHINE, PASEO_SOURCE, PaseoWriter, SERVER_ID, startCenter } from '../../tests/helpers/center.ts';
import { inProcessClient } from '../server/in-process.ts';
import { normalizeEntry } from '../server/collector/normalize.ts';

const centers: ReturnType<typeof startCenter>[] = [];
afterEach(() => { for (const center of centers.splice(0)) center.close(); });

test('Local and HTTP ingest store identical rows and acknowledge the same checkpoint.', async () => {
  const http = startCenter();
  const local = startCenter();
  centers.push(http, local);
  const writer = new PaseoWriter(http);
  const client = inProcessClient(local.db, { sourceId: PASEO_SOURCE, machine: MACHINE, serverId: SERVER_ID }, () => http.now);
  await writer.lease();
  await client.lease({ source_id: PASEO_SOURCE, instance_id: writer.instance, server_id: SERVER_ID, collector_version: '0.2.0' });
  const snapshot = writer.snapshotBody([agent('sample')]);
  await http.app.request('/ingest/v2/snapshot', { method: 'POST', headers: { authorization: 'Bearer ' + writer.token, 'content-type': 'application/json' }, body: JSON.stringify(snapshot) });
  await client.snapshot(snapshot);
  const batch = writer.batchBody('sample', null, { epoch: 'epoch-1', seq: 1 }, [event('msg:sample', 1)]);
  expect(await client.batch(batch)).toEqual((await writer.batch(batch)).json);
  for (const table of ['source_events', 'chunks']) {
    expect(local.db.prepare('SELECT * FROM ' + table).all()).toEqual(http.db.prepare('SELECT * FROM ' + table).all());
  }
  expect(await client.checkpoint('sample')).toEqual((await writer.checkpoint('sample')).json);
});

test('An in-process collector resumes at the checkpoint previously acknowledged over HTTP.', async () => {
  const center = startCenter();
  centers.push(center);
  const writer = new PaseoWriter(center);
  await writer.lease();
  await writer.snapshot([agent('sample')]);
  const cursor = { epoch: 'epoch-1', seq: 1 };
  const batch = writer.batchBody('sample', null, cursor, [event('msg:sample', 1)]);
  await writer.batch(batch);
  const client = inProcessClient(center.db, { sourceId: PASEO_SOURCE, machine: MACHINE, serverId: SERVER_ID }, () => center.now);
  expect(await client.checkpoint('sample')).toMatchObject({ checkpoint: cursor });
});

test('The plugin preserves the upstream turn ID on a message.', () => {
  expect(normalizeEntry({ turnId: 'turn-1', provider: 'claude', timestamp: new Date().toISOString(), seqStart: 1, seqEnd: 1,
    collapsed: [], sourceSeqRanges: [], item: { type: 'user_message', text: 'sample' } }, 'epoch-1', new Date())).toMatchObject({ event: { turn_id: 'turn-1' } });
});
