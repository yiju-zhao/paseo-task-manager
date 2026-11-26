import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { Upstream } from '../../src/context/upstream.ts';
import { readItem, readOverview, readSession, readTurn } from '../../src/context/read.ts';
import { execute } from '../../src/domain/execute.ts';
import { getProject, listProjects } from '../../src/domain/read.ts';
import { ChangeFeed } from '../../src/server/change-feed.ts';
import { searchContext } from '../../src/server/search.ts';
import { disabledStatus } from '../../src/understand/status.ts';
import { agent, config, event, OTHER_SOURCE, OTHER_TOKEN, PaseoWriter, startCenter, type Center } from '../../tests/helpers/center.ts';
import { registerBoard } from '../server/board.ts';

let center: Center;
let feed: ChangeFeed;
const handle = vi.fn();
const remote = config.paseoCollectors![OTHER_SOURCE].serverId;
const address = 's:abcd1234';
const upstream = vi.fn<Upstream>();
const sources = { config, startedAt: new Date('2026-11-06T09:00:00Z'), upstream };
let isRunning: boolean;
async function call(name: string, input: object = {}) {
  const [contract, invoke] = handle.mock.calls.find(([rpc]) => rpc.name === 'board.' + name)!;
  return contract.output.parse(await invoke(contract.input.parse(input)));
}

beforeEach(async () => {
  center = startCenter();
  upstream.mockReset();
  isRunning = true;
  feed = new ChangeFeed(center.db, { now: () => center.now, status: disabledStatus });
  const writer = new PaseoWriter(center, 'remote-writer', OTHER_TOKEN, OTHER_SOURCE, remote);
  await writer.lease();
  await writer.snapshot([agent('agent-remote', { native_id: 'abcd1234', native_id_origin: 'runtime', status: 'blocked' })]);
  await writer.batch(writer.batchBody('agent-remote', null, { epoch: 'epoch-1', seq: 1 }, [event('prompt', 1, { kind: 'user' })]));
  const deps = { now: () => center.now, newId: (prefix: string) => prefix + '_fixture' };
  execute(center.db, deps, { op: 'create_project', args: { title: 'Demo project' }, actor: 'user' });
  execute(center.db, deps, { op: 'link_session', args: { project: 'p_fixture', session: 'claude:abcd1234' }, actor: 'user' });
  handle.mockClear();
  registerBoard({ handle }, {
    center: async () => isRunning ? { db: center.db, feed, sources } : { reason: '数据库缺失' },
    now: () => center.now, whenReady: () => () => {},
  });
});
afterEach(() => { feed.stop(); center.close(); });

test('The board preserves overview order and the panel reader’s change window.', async () => {
  expect((await call('overview')).value.overview).toEqual(readOverview(center.db, center.now, 'panel', sources));
});

test('Reading the sidebar leaves the main screen’s unread changes available.', async () => {
  await call('overview');
  expect((await call('overview', { markRead: true })).value.overview.changes).toHaveLength(1);
  expect((await call('overview')).value.overview.changes).toEqual([]);
});

test('The board lists the domain project cards.', async () => {
  expect((await call('projects')).value).toEqual(listProjects(center.db, center.now, {}));
});
test('The project page reads the full domain detail.', async () => {
  expect((await call('project', { id: 'p_fixture' })).value).toEqual(getProject(center.db, center.now, 'p_fixture'));
});
test('Searching returns the domain search addresses.', async () => {
  expect((await call('search', { query: 'Demo' })).value).toEqual(searchContext(center.db, 'Demo', { scope: 'all', limit: 20 }));
});
test('The session page preserves the domain card and turn outline.', async () => {
  expect((await call('session', { address })).value.session).toEqual(readSession(center.db, center.now, 'abcd1234', {}));
});
test('The session opens the observing remote daemon’s agent.', async () => {
  expect((await call('session', { address })).value.agent).toEqual({ agentId: 'agent-remote', serverId: remote });
});
test('A pending session opens the same remote agent.', async () => {
  expect((await call('overview')).value.targets[address].agent).toEqual({ agentId: 'agent-remote', serverId: remote });
});
test('Turn entries retain their address and source text.', async () => {
  expect((await call('turn', { address: address + '#1' })).value).toEqual(readTurn(center.db, 'abcd1234', 1));
});
test('Reading an item respects the requested page offset.', async () => {
  expect((await call('item', { address: address + '#1.1', offset: 4 })).value).toEqual(readItem(center.db, 'abcd1234', 1, 1, { offset: 4 }));
});
test('Only a workspace on the observing host links to its project.', async () => {
  expect((await call('workspace', { directory: '/work/proj', serverId: remote })).value.map((p: {id: string}) => p.id)).toEqual(['p_fixture']);
  expect((await call('workspace', { directory: '/work/proj', serverId: 'other' })).value).toEqual([]);
});
test('A workspace with no matching session has no project.', async () => {
  expect((await call('workspace', { directory: '/work/other', serverId: remote })).value).toEqual([]);
});
test('An unavailable center returns its reason through the RPC.', async () => {
  isRunning = false;
  expect(await call('projects')).toEqual({ reason: '数据库缺失' });
});
test('A feed change reaches a subscriber once and stops on release.', async () => {
  const subscription = handle.mock.calls.find(([rpc]) => rpc.name === 'board.changes')![1];
  const controller = new AbortController();
  const push = vi.fn().mockResolvedValue(undefined);
  subscription({}, { signal: controller.signal, push });
  await vi.waitFor(() => expect(push).toHaveBeenCalledWith('ready'));
  push.mockClear();
  center.db.prepare("UPDATE sessions SET title='updated'").run();
  feed.poll();
  feed.poll();
  controller.abort();
  center.db.prepare("UPDATE sessions SET title='after release'").run();
  feed.poll();
  expect(push.mock.calls).toEqual([['sessions']]);
});

test('A new timeline item notifies the session page when the agent status stays the same.', async () => {
  const push = vi.fn();
  const unsubscribe = feed.subscribe(push);
  const writer = new PaseoWriter(center, 'remote-writer', OTHER_TOKEN, OTHER_SOURCE, remote);
  await writer.lease();
  const position = { epoch: 'epoch-1', seq: 1 };
  await writer.batch(writer.batchBody('agent-remote', position, { ...position, seq: 2 }, [event('reply', 2)]));
  feed.poll();
  unsubscribe();
  expect(push.mock.calls).toEqual([[{ type: 'sessions' }]]);
});

test('An event used as evidence opens the original ledger entry.', async () => {
  const entry = getProject(center.db, center.now, 'p_fixture')!.events[0];
  expect((await call('evidence', { ref: 'event:' + entry.id })).value).toMatchObject({
    kind: 'event', text: entry.op, project_id: 'p_fixture', at: entry.occurred_at,
  });
});

test('Expanding a cleared tool reads the requested page from its source.', async () => {
  const writer = new PaseoWriter(center, 'remote-writer', OTHER_TOKEN, OTHER_SOURCE, remote);
  await writer.lease();
  const position = { epoch: 'epoch-1', seq: 1 };
  await writer.batch(writer.batchBody('agent-remote', position, { ...position, seq: 2 }, [
    event('tool', 2, { kind: 'tool', text: '', tool: { name: 'read', status: 'completed', exit_code: 0,
      input: '', output: 'original', error: null, input_truncated: null, output_truncated: null } }),
  ]));
  center.db.exec("UPDATE source_events SET meta=json_set(meta, '$.detail_cleared_at', 'fixture', '$.tool.output', '') WHERE kind='tool'");
  upstream.mockResolvedValue({ text: 'a'.repeat(4000) + 'second page' });
  await call('turn', { address: address + '#1' });
  expect(upstream).not.toHaveBeenCalled();
  expect((await call('item', { address: address + '#1.2', offset: 4000 })).value.text).toBe('second page');
});

test('A legacy chunk citation opens its original text with a line hint.', async () => {
  const chunk = center.db.prepare('SELECT id, text FROM chunks LIMIT 1').get()!;
  expect((await call('evidence', { ref: 'chunk:' + chunk.id + '#L1' })).value.chunks[0].text).toBe(chunk.text);
});
