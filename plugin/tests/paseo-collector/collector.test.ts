import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { createCenterClient } from '../../server/collector/client.ts';
import { PaseoCollectorConfig } from '../../server/collector/config.ts';
import { PaseoCollector } from '../../server/collector/loop.ts';
import { Outbox } from '../../server/collector/outbox.ts';
import { StateDir } from '../../server/collector/state-store.ts';
import { BatchV2, LeaseRequest, SnapshotV2, type Cursor } from '../../server/protocol/ingest-v2.ts';
import { FakePaseo, FAKE_SERVER_ID } from '../helpers/fake-paseo.ts';

test('the collector pages, filters reasoning and retries the identical durable batch after an ACK is lost', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'task-manager-wire-'));
  const fake = new FakePaseo();
  fake.addAgent('work');
  fake.user('work', 'first', 'u1');
  fake.reasoning('work', 'private reasoning');
  fake.assistant('work', 'last', 'a1');
  const config = PaseoCollectorConfig.parse({ sourceId:'fixture', machine:'fixture', stateDir:dir,
    server:'http://test.invalid', tokenFile:'/unused', paseo:{serverId:FAKE_SERVER_ID,url:'ws://test.invalid/ws'}, pageLimit:1, debounceMs:0 });
  let cursor: Cursor | null = null;
  let rev = 0;
  const received: BatchV2[] = [];
  const events = new Map<string,string>();
  let loseAck = true;
  const client = createCenterClient({server:config.server, token:'fixture-token', fetch:async (url, init) => {
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer fixture-token');
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (path === '/ingest/v2/lease') {
      expect(LeaseRequest.parse(body).server_id).toBe(FAKE_SERVER_ID);
      return Response.json({lease_epoch:1,snapshot_rev:rev,expires_at:'2099-01-01T00:00:00Z'});
    }
    if (path === '/ingest/v2/snapshot') {
      rev = SnapshotV2.parse(body).snapshot_rev;
      return Response.json({ok:true,snapshot_rev:rev,lease_expires_at:'2099-01-01T00:00:00Z'});
    }
    if (path === '/ingest/v2/checkpoint') return Response.json({agent_id:'work',session_key:null,checkpoint:cursor,state:null,last_batch_id:null});
    expect(path).toBe('/ingest/v2/batches');
    const batch = BatchV2.parse(body);
    received.push(batch);
    cursor = batch.next;
    for (const event of batch.events) events.set(event.key,event.text);
    if (loseAck) throw new Error('connection lost after receipt');
    return Response.json({batch_id:batch.batch_id,agent_id:'work',checkpoint:cursor,session_key:'native-work',
      accepted:batch.events.length,duplicates:0,materialized:batch.events.length,standby:0,review:0});
  }});
  const outbox = new Outbox(dir);
  function collector() {
    return new PaseoCollector(config, {sdk:fake,client,outbox,state:StateDir.open(dir,{sourceId:config.sourceId,serverId:FAKE_SERVER_ID,server:config.server}),
      now:()=>new Date(),workspace:async()=>null,log:()=>{}});
  }
  let current = collector();
  try {
    await current.start();
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0));
    await current.stop();
    expect(outbox.usage().batches).toBe(1);
    loseAck = false;
    current = collector();
    await current.start();
    await vi.waitFor(() => expect([...events.values()]).toEqual(['first','last']));
    expect(received[1]).toEqual(received[0]);
    expect(outbox.usage().batches).toBe(0);
    expect(fake.resumedByRead).toEqual([]);
  } finally {
    await current.stop();
    rmSync(dir,{recursive:true,force:true});
  }
});
