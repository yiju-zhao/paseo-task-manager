import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { contextTools } from '../../src/mcp/context-tools.ts';
import { confirmOptions, createQuestion } from '../../src/domain/questions.ts';
import { execute } from '../../src/domain/execute.ts';
import type { QuestionDraft } from '../../src/domain/questions.ts';
import type { OpName } from '../../src/domain/ops.ts';
import { diffFeed, readFeedState } from '../../src/server/change-feed.ts';
import { createApp } from '../../src/server/http.ts';
import { createMergePreviews } from '../../src/server/merge-routes.ts';
import { disabledStatus } from '../../src/understand/status.ts';
import { config, herdrSession, herdrSnapshot } from '../../tests/helpers/center.ts';
import { setup } from '../../tests/domain/helpers.ts';
import { applySnapshot } from '../../src/server/sessions-repo.ts';
import { registerBoardWrites } from '../server/board-writes.ts';

const key = 'codex:session1';
function example() {
  const { db, deps, user } = setup();
  applySnapshot(db, herdrSnapshot([herdrSession(key)]), deps.now());
  const project = 'p_1';
  user('create_project', { title: 'Alpha' });
  user('create_project', { title: 'Bravo' });
  user('upsert_milestone', { project, title: 'First' });
  user('upsert_todo', { project, title: 'Review' });
  user('record_decision', { project, text: 'Use the ledger' });
  user('set_blocker', { project, text: 'Approve scope', kind: 'user' });
  user('link_session', { project, session: key });
  const prompt: QuestionDraft = { kind: 'confirm', prompt: 'Proceed?', options: confirmOptions('transition_stage', { project, stage: 'build' }),
    project_id: project, session_key: null, evidence: [], guards: [], dedupe_key: 'scope', created_by: 'user' };
  createQuestion(db, deps, prompt);
  db.prepare("INSERT INTO chunks(session_key,kind,ts_start,ts_end,text,backfill) VALUES (?,'transcript',?,?,?,0)")
    .run(key, deps.now().toISOString(), deps.now().toISOString(), '合并原始证据');
  const scheduler = { status: disabledStatus, requestSync: vi.fn(), requestProjectReview: vi.fn() };
  const previews = createMergePreviews(db, deps, { model: () => 'fixture', runner: async () => ({
    ok: true, text: '', structured: { title: 'Bravo', title_change_reason: '', summary: '合并摘要', why: '统一查看', done_criteria: ['核对'],
      unknowns: [], evidence: [{ field: 'summary', chunk_ids: [1] }, { field: 'done_criteria', chunk_ids: [1] }] },
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 }, costUsd: 0, durationMs: 1,
  }) });
  const api = createApp(db, config, deps.now, deps.newId, { scheduler, previews });
  const handle = vi.fn();
  registerBoardWrites({ handle }, async () => ({ db, deps, previews, scheduler, sources: { config, startedAt: deps.now() } }));
  async function http(method: string, path: string, body?: object) {
    const response = await api.request(path, { method, headers: { authorization: 'Bearer ' + config.userToken, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return response.json();
  }
  async function rpc(name: string, input: object) {
    const [contract, invoke] = handle.mock.calls.find(([rpc]) => rpc.name === 'board.' + name)!;
    return contract.output.parse(await invoke(contract.input.parse(input)));
  }
  const records = () => Object.fromEntries(['events', 'projects', 'milestones', 'todos', 'decisions', 'blockers',
    'contributions', 'questions', 'reminder_snoozes', 'sessions', 'project_reviews', 'merge_previews']
    .map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]));
  return { db, deps, http, rpc, records, scheduler };
}
let web: ReturnType<typeof example>;
let plugin: ReturnType<typeof example>;
beforeEach(() => { web = example(); plugin = example(); });
afterEach(() => { web.db.close(); plugin.db.close(); });

type Comparison = [string, OpName, object, string, string, object?];
const project = 'p_1';
const cases: Comparison[] = [
  ['Creating a project', 'create_project', { title: 'New' }, 'POST', '/projects', { title: 'New' }],
  ['Editing the brief', 'update_project', { project, fields: { title: 'Renamed', summary: 'Next', why: 'Scope', done_criteria: 'Reviewed', priority: 'P0' } }, 'PATCH', '/projects/p_1', { title: 'Renamed', summary: 'Next', why: 'Scope', done_criteria: 'Reviewed', priority: 'P0' }],
  ['Unlocking a project field', 'unlock_field', { table: 'projects', id: project, field: 'title' }, 'DELETE', '/projects/p_1/locks/title'],
  ['Changing stage', 'transition_stage', { project, stage: 'build' }, 'POST', '/projects/p_1/stage', { stage: 'build' }],
  ['Adding a milestone', 'upsert_milestone', { project, title: 'Ship' }, 'POST', '/projects/p_1/milestones', { title: 'Ship' }],
  ['Editing a milestone', 'upsert_milestone', { project, id: 'm_1', status: 'done', position: 2 }, 'PATCH', '/projects/p_1/milestones/m_1', { status: 'done', position: 2 }],
  ['Unlocking a milestone', 'unlock_field', { table: 'milestones', id: 'm_1', field: 'title' }, 'DELETE', '/projects/p_1/milestones/m_1/locks/title'],
  ['Deleting a milestone', 'delete_milestone', { project, id: 'm_1' }, 'DELETE', '/projects/p_1/milestones/m_1'],
  ['Adding a todo', 'upsert_todo', { project, title: 'Ship' }, 'POST', '/projects/p_1/todos', { title: 'Ship' }],
  ['Editing a todo', 'upsert_todo', { project, id: 't_1', milestone_id: 'm_1', priority: 'P0', status: 'doing' }, 'PATCH', '/projects/p_1/todos/t_1', { milestone_id: 'm_1', priority: 'P0', status: 'doing' }],
  ['Unlocking a todo', 'unlock_field', { table: 'todos', id: 't_1', field: 'title' }, 'DELETE', '/projects/p_1/todos/t_1/locks/title'],
  ['Deleting a todo', 'delete_todo', { project, id: 't_1' }, 'DELETE', '/projects/p_1/todos/t_1'],
  ['Recording a decision', 'record_decision', { project, text: 'Proceed' }, 'POST', '/projects/p_1/decisions', { text: 'Proceed' }],
  ['Deleting a decision', 'delete_decision', { project, id: 'd_1' }, 'DELETE', '/projects/p_1/decisions/d_1'],
  ['Adding a blocker', 'set_blocker', { project, text: 'Review' }, 'POST', '/projects/p_1/blockers', { text: 'Review' }],
  ['Editing a blocker', 'set_blocker', { project, id: 'b_1', text: 'Await delivery', kind: 'external' }, 'PATCH', '/projects/p_1/blockers/b_1', { text: 'Await delivery', kind: 'external' }],
  ['Clearing a blocker', 'clear_blocker', { project, id: 'b_1' }, 'PATCH', '/projects/p_1/blockers/b_1', { status: 'cleared' }],
  ['Deleting a blocker', 'delete_blocker', { project, id: 'b_1' }, 'DELETE', '/projects/p_1/blockers/b_1'],
  ['Linking a session', 'link_session', { project: 'p_2', session: key }, 'POST', '/sessions/' + key + '/links', { project_id: 'p_2' }],
  ['Unlinking a session', 'unlink_session', { project, session: key }, 'DELETE', '/sessions/' + key + '/links/p_1'],
  ['Ignoring a session', 'ignore_session', { session: key, ignored: true }, 'PUT', '/sessions/' + key + '/ignored', { ignored: true }],
  ['Reverting a change', 'revert_event', { event_id: 7 }, 'POST', '/events/7/revert'],
];
test.each(cases)('%s has the same effect through both transports.', async (_, op, args, method, path, body) => {
  const expected = await web.http(method, path, body);
  const actual = await plugin.rpc('operate', { op, args });
  expect(actual.status).toBe('applied');
  expect(actual).toEqual(expected);
  expect(plugin.records()).toEqual(web.records());
});
test.each(['answer', 'dismiss'])('Question %s matches the web result and event history.', async action => {
  const answer = { option_index: 0 };
  const expected = await web.http('POST', '/questions/q_1/' + action, action === 'answer' ? answer : undefined);
  expect(await plugin.rpc(action, action === 'answer' ? { id: 'q_1', answer } : { id: 'q_1' })).toEqual(expected);
  expect(plugin.records()).toEqual(web.records());
});
test.each([24, null])('Snoozing for %s stores the same reminder fingerprint and expiry.', async hours => {
  const body = { key: 'blocker:b_1', hours };
  expect(await plugin.rpc('snooze', body)).toEqual(await web.http('POST', '/reminders/snooze', body));
  expect(plugin.records()).toEqual(web.records());
});
test('Both transports request one manual sync.', async () => {
  expect(await plugin.rpc('sync', {})).toEqual(await web.http('POST', '/sync'));
  expect(plugin.scheduler.requestSync).toHaveBeenCalledTimes(1);
  expect(web.scheduler.requestSync).toHaveBeenCalledTimes(1);
});
test.each([undefined, [key]])('Previewing and applying a merge of %s produces the same draft and ledger.', async sessions => {
  const request = { target: 'p_2', sessions };
  const started = await web.http('POST', '/projects/p_1/merge-previews', request);
  expect(await plugin.rpc('preview', { source: project, ...request })).toEqual(started);
  const id = 'mp_1';
  const expected = await web.http('GET', '/merge-previews/' + id);
  expect(expected.status, expected.error).toBe('ready');
  expect(await plugin.rpc('merge.read', { id })).toEqual(expected);
  expect(await plugin.rpc('merge.apply', { id, overwrite_locked: ['summary'] })).toEqual(await web.http('POST', '/merge-previews/' + id + '/apply', { overwrite_locked: ['summary'] }));
  expect(plugin.records()).toEqual(web.records());
});
test.each([
  ['update_project', { project, fields: { priority: 'P9' } }],
  ['transition_stage', { project, stage: 'idea' }],
])('A rejected %s gives the web route’s reason and writes nothing.', async (op, args) => {
  const before = plugin.records();
  const expected = op === 'update_project' ? await web.http('PATCH', '/projects/p_1', { priority: 'P9' }) : await web.http('POST', '/projects/p_1/stage', { stage: 'idea' });
  expect(await plugin.rpc('operate', { op, args })).toEqual({ status: 'rejected', code: expected.error, message: expected.message });
  expect(plugin.records()).toEqual(before);
});
test('The MCP change summary names the project before its callable ID.', async () => {
  execute(plugin.db, plugin.deps, { actor: 'user', op: 'update_project', args: { project, fields: { title: 'Current title' } } });
  const overview = contextTools(plugin.db, plugin.deps, 'fixture').find(tool => tool.name === 'pm_overview')!;
  expect((await overview.handler({})).text).toMatch(/Current title[^\n]*p_1/);
});

test('A snoozed reminder refreshes when saved and again when it expires.', async () => {
  const { db, deps } = plugin;
  const read = (at: Date) => readFeedState(db, at, disabledStatus());
  const now = deps.now();
  const before = read(now);
  await plugin.rpc('snooze', { key: 'blocker:b_1', hours: 1 });
  const snoozed = read(now);
  expect(diffFeed(db, before, snoozed)).toContainEqual({ type: 'questions' });
  expect(diffFeed(db, snoozed, read(new Date(+now + 3600000)))).toContainEqual({ type: 'questions' });
});
test('A completed preview refreshes the open preview without a ledger event.', async () => {
  const { db, deps } = plugin;
  const row = db.prepare("INSERT INTO merge_previews(id,source_id,target_id,mode,session_keys,status,signature,created_at,updated_at) VALUES ('mp_demo','p_1','p_2','project','[]','generating','sample',?,?)");
  row.run(deps.now().toISOString(), deps.now().toISOString());
  const before = readFeedState(db, deps.now(), disabledStatus());
  db.exec("UPDATE merge_previews SET status='failed' WHERE id='mp_demo'");
  expect(diffFeed(db, before, readFeedState(db, deps.now(), disabledStatus()))).toEqual([{ type: 'status' }]);
});

test('A typed answer executes the same operation as submitting text on the web.', async () => {
  for (const side of [plugin, web]) createQuestion(side.db, side.deps, { kind: 'text', prompt: 'New title?', dedupe_key: 'rename',
    project_id: project, session_key: null, evidence: [], guards: [], created_by: 'user',
    options: [{ label: 'Rename', op: 'update_project', args: { project, fields: {} }, text_arg: 'fields.title' }] });
  const answer = { text: 'Revised title' };
  expect(await plugin.rpc('answer', { id: 'q_2', answer })).toEqual(await web.http('POST', '/questions/q_2/answer', answer));
  expect(plugin.records()).toEqual(web.records());
});

test('A reminder that already disappeared returns the web refusal reason.', async () => {
  const snooze = { key: 'unknown', hours: 24 };
  const expected = await web.http('POST', '/reminders/snooze', snooze);
  expect(await plugin.rpc('snooze', snooze)).toEqual({ status: 'rejected', code: expected.error, message: expected.message });
});

test('Both transports wake the project review requested by a structural edit.', async () => {
  await plugin.rpc('operate', { op: 'unlink_session', args: { project, session: key } });
  await web.http('DELETE', '/sessions/' + key + '/links/p_1');
  expect(plugin.scheduler.requestProjectReview).toHaveBeenCalledOnce();
  expect(web.scheduler.requestProjectReview).toHaveBeenCalledOnce();
});

test('Resuming an ignored session matches the web route.', async () => {
  for (const side of [plugin, web]) execute(side.db, side.deps, { actor: 'user', op: 'ignore_session', args: { session: key, ignored: true } });
  expect(await plugin.rpc('operate', { op: 'ignore_session', args: { session: key, ignored: false } }))
    .toEqual(await web.http('PUT', '/sessions/' + key + '/ignored', { ignored: false }));
  expect(plugin.records()).toEqual(web.records());
});

test('A stale merge approval preserves both projects and reports the same reason as the web route.', async () => {
  await plugin.rpc('preview', { source: project, target: 'p_2' });
  await web.http('POST', '/projects/p_1/merge-previews', { target: 'p_2' });
  for (const side of [plugin, web]) execute(side.db, side.deps, { actor: 'user', op: 'update_project', args: { project: 'p_2', fields: { why: 'Changed after preview' } } });
  const before = plugin.records();
  const expected = await web.http('POST', '/merge-previews/mp_1/apply', {});
  expect(await plugin.rpc('merge.apply', { id: 'mp_1' }))
    .toEqual({ status: 'rejected', code: 'stale', message: expected.message });
  expect(plugin.records()).toEqual(before);
});
