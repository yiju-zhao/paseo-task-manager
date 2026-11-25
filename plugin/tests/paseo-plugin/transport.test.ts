import { expect, test } from 'vitest';
import { routedReader, type HostScope } from '../../server/transport.ts';
import { settings } from '../../shared/settings.ts';

// Throw on any attempt to inspect a transport capability not on this explicit allowlist.
function allow<T extends object>(values: T): T {
  return new Proxy(values, { get(target, key, receiver) {
    if (!Object.hasOwn(target, key)) throw new Error('unexpected SDK access: ' + String(key));
    return Reflect.get(target, key, receiver);
  } });
}
function setup() {
  let archivedAt: string | null = null;
  let status = 'idle', enabled = false, selected = true;
  const calls: string[] = [];
  const agent = () => ({ status, archivedAt, id: 'a', capabilities: { supportsStreaming:true }, availableModes:['default'] });
  const sub = Object.assign(() => { calls.push('unsubscribe'); }, { ready: Promise.resolve() });
  const timeline = allow({
    refetch: async () => { calls.push('page'); return { agent: agent() }; },
    subscribe: () => { calls.push('subscribe'); return sub; },
  });
  const handle = allow({ refresh: async () => { calls.push('refresh'); return { agent:agent() }; }, timeline });
  const agents = allow({
    ref: () => handle,
    list: async () => ({ entries:[], pageInfo:{ hasMore:false, nextCursor:null }, subscription:{ ready:Promise.resolve(), release:async()=>{} } }),
    subscribe: () => () => {},
  });
  const api = allow({ agents, dispose: async () => { calls.push('dispose'); } });
  const sdk = routedReader(api as unknown as HostScope, 'server', () => 'connected', () => selected, () => enabled);
  return { sdk, calls, archive: () => { archivedAt = '2026-11-24'; }, closeAgent: () => { status = 'closed'; }, optIn: () => { enabled = true; }, deselect: () => { selected = false; } };
}

test('settings start with no hosts selected and closed content disabled', () => {
  expect(settings.schema.parse({})).toEqual({ selectedHosts: [], readClosed: false, toolLimit: 2 * 1024 ** 3 });
});

test('only read and lifecycle methods escape; SDK calls stay on the allowlist', async () => {
  const { sdk,calls } = setup();
  expect(Object.keys(sdk).sort()).toEqual(['close','connect','connectionStatus','fetchAgent','fetchTimeline','listAgents','serverId','subscribeDirectory','subscribeTimeline']);
  expect(() => Reflect.apply(Reflect.get(sdk,'send'),sdk,[])).toThrow();
  await sdk.connect();
  await sdk.listAgents({limit:10,includeArchived:false,includeBackground:true});
  (await sdk.subscribeDirectory(()=>{},true))();
  await sdk.fetchAgent('a');
  (await sdk.subscribeTimeline('a',()=>{}))();
  await sdk.fetchTimeline('a',{direction:'tail',limit:1});
  await sdk.close();
  expect(calls).toEqual(['refresh','refresh','subscribe','unsubscribe','refresh','page','dispose']);
});

test('rechecks after directory lookup and between pages; opt-in and deselection take effect at read time', async () => {
  const t=setup();
  await t.sdk.fetchTimeline('a',{direction:'tail',limit:1});
  t.closeAgent();
  await expect(t.sdk.fetchTimeline('a',{direction:'after',limit:1})).rejects.toThrow();
  await expect(t.sdk.subscribeTimeline('a',()=>{})).rejects.toThrow();
  expect(t.calls).toEqual(['refresh','page','refresh','refresh']);
  t.optIn();
  await t.sdk.fetchTimeline('a',{direction:'tail',limit:1});
  t.deselect();
  await expect(t.sdk.fetchTimeline('a',{direction:'tail',limit:1})).rejects.toThrow();
  expect(t.calls.filter(c=>c==='page')).toHaveLength(2);
});

test('archived agents are metadata-only by default; opt-in reads pages without subscribing', async () => {
  const t = setup();
  t.archive();
  await expect(t.sdk.fetchTimeline('a', {direction:'tail',limit:1})).rejects.toThrow();
  t.optIn();
  await t.sdk.fetchTimeline('a', {direction:'tail',limit:1});
  await expect(t.sdk.subscribeTimeline('a', () => {})).rejects.toThrow();
  expect(t.calls).toEqual(['refresh','refresh','page','refresh']);
});
