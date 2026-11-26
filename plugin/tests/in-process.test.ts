import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { agent, event, MACHINE, PASEO_SOURCE, PaseoWriter, SERVER_ID, startCenter } from '../../tests/helpers/center.ts';
import type { CenterClient } from '../server/collector/client.ts';
import { PaseoCollectorConfig } from '../server/collector/config.ts';
import { PaseoCollector } from '../server/collector/loop.ts';
import { Outbox } from '../server/collector/outbox.ts';
import { StateDir } from '../server/collector/state-store.ts';
import { FakePaseo } from './helpers/fake-paseo.ts';
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

test('An in-process release hands its source immediately to an HTTP writer.', async () => {
  const center = startCenter();
  centers.push(center);
  const client = inProcessClient(center.db, { sourceId: PASEO_SOURCE, machine: MACHINE, serverId: SERVER_ID }, () => center.now);
  const owner = { source_id: PASEO_SOURCE, instance_id: 'outgoing-writer', server_id: SERVER_ID, collector_version: 'fixture' };
  const lease = await client.lease(owner);
  await client.releaseLease({ source_id: PASEO_SOURCE, instance_id: owner.instance_id, lease_epoch: lease.lease_epoch });
  const next = new PaseoWriter(center, 'incoming-writer');
  expect((await next.lease()).status).toBe(200);
});

test('A replacement plugin writer replays a lost acknowledgement without duplicating the committed event.', async () => {
  const center = startCenter();
  centers.push(center);
  const dir = mkdtempSync(join(tmpdir(), 'lease-handoff-'));
  const source = { sourceId: PASEO_SOURCE, machine: MACHINE, serverId: SERVER_ID };
  const config = PaseoCollectorConfig.parse({ ...source, stateDir: dir, debounceMs: 0, paseo: { url: 'ws://fixture.test/ws', serverId: SERVER_ID } });
  const client = inProcessClient(center.db, source, () => center.now);
  const sent = Promise.withResolvers<void>();
  const disconnect = Promise.withResolvers<void>();
  const outbox = new Outbox(dir);
  function collector(writer: string, transport: CenterClient): PaseoCollector {
    const sdk = new FakePaseo();
    sdk.addAgent('handoff');
    sdk.user('handoff', 'durable message', 'u1');
    return new PaseoCollector(config, { sdk, client: transport, outbox, now: () => center.now, log: () => {},
      state: StateDir.open(dir, { sourceId: PASEO_SOURCE, serverId: SERVER_ID, server: 'fixture' }, writer) });
  }
  const first = collector('outgoing-writer', { ...client, batch: async body => {
    await client.batch(body);
    sent.resolve();
    await disconnect.promise;
    throw new Error('ack lost');
  } });
  let second: PaseoCollector | undefined;
  try {
    await first.start();
    await sent.promise;
    const stopping = first.stop();
    disconnect.resolve();
    await stopping;
    expect(outbox.usage().batches).toBe(1);
    second = collector('incoming-writer', client);
    await second.start();
    await vi.waitFor(() => expect(outbox.usage().batches).toBe(0));
    expect(center.db.prepare('SELECT text FROM source_events').all()).toEqual([{ text: 'durable message' }]);
  } finally {
    disconnect.resolve();
    await first.stop();
    await second?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
