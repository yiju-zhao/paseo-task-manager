import { defineRpc, defineSubscription } from '@getpaseo/plugin';
import { z } from 'zod';

import { STAGES } from '../../src/shared/vocab.ts';

const string = z.string();
const optionalText = string.nullable();
const number = z.number();
const strings = z.array(string);
const empty = z.object({});
const address = z.object({ address: string.min(1) });
const agent = z.object({ agentId: string, serverId: string });
const checked = { created_at: string, created_by: string, checked_at: optionalText.optional(), checked_ref: optionalText.optional() };
const task = z.looseObject({ ...checked, id: string, title: string, status: string, milestone_id: optionalText.optional() });
const blocker = z.looseObject({ ...checked, id: string, text: string, status: string, kind: string });
const sessionTag = z.looseObject({ short_id: string, title: string, machine: string, effective_status: string });
const question = z.looseObject({ id: string, prompt: string, context: optionalText, created_at: string, created_by: string, evidence: strings });
const project = z.looseObject({
  id: string, title: string, stage: z.enum(STAGES), priority: optionalText, summary: optionalText, why: optionalText,
  done_criteria: optionalText, created_by: string, created_at: string, locks: strings, last_activity_at: string,
  current_milestone: z.looseObject({ title: string, checked_ref: optionalText.optional() }).nullable(), open_todos: task.array(), open_blockers: blocker.array(),
  pending_questions: question.array(),
});
const detail = project.extend({
  milestones: task.array(), todos: task.array(), blockers: blocker.array(),
  decisions: z.looseObject({ ...checked, id: string, text: string, evidence: strings, decided_at: string }).array(),
  contributions: z.looseObject({ id: string, summary: optionalText, actor: string, created_at: string, ts_end: optionalText, session: sessionTag.nullable() }).array(),
  events: z.looseObject({ id: number, occurred_at: string, actor: string, op: string, entity: optionalText, reason: optionalText, evidence: strings }).array(),
});
const overview = z.object({
  healthySources: number, undigested: number, refusals: number, last_event_id: number,
  sources: z.object({ id: string, state: string, last_sync: optionalText }).array(),
  pending: z.looseObject({ text: string, since: optionalText, ref: string }).array(),
  running: z.object({ address: string, machine: string, projects: strings, turn: number.nullable(), age_ms: number.nullable(), user: string }).array(),
  changes: z.object({ project_id: string, stages: number, decisions: number, completed_todos: number, new_blockers: number, cleared_blockers: number }).array(),
});
const session = z.looseObject({
  address: string, machine: string, title: string, status: string, projects: strings, card_as_of_turn: number.nullable(),
  card: z.object({ goal: string, state: string, waiting_on: optionalText, next: optionalText, note: optionalText }).nullable(),
  earlier: number, earlier_digests: number, no_turn_index: z.boolean(), digests: z.object({ id: number, ts_end: optionalText, json: optionalText }).array(),
  turns: z.looseObject({ address: string, n: number, user: string, assistant: string, in_progress: z.boolean(), refused: z.boolean(), tool_calls: number, tool_failures: number }).array(),
});
const turn = z.object({
  address: string, items: z.object({ address: string, text: string, kind: string, refused: z.boolean(), detail: string.optional(), cleared: z.boolean().optional(),
    tool: z.object({ name: string, input: string, status: string, exit_code: number.nullable() }).nullable() }).array(),
});
function read<I extends z.ZodType, V extends z.ZodType>(name: string, input: I, value: V) {
  return defineRpc({ name: 'board.' + name, input, output: z.union([z.object({ reason: string }), z.object({ value })]) });
}
export const boardOverview = read('overview', z.object({ markRead: z.boolean().optional() }), z.object({
  overview, contentGaps: number, incomplete: number, targets: z.record(string, z.object({ address: optionalText, project: optionalText, agent: agent.nullable() })),
  at: string, machines: z.object({ id: string, machine: string, state: string, last_sync: optionalText }).array(),
  excluded: number, usage: z.object({ used: number, limit: number, oldest: optionalText, blocked: z.boolean() }).nullable(),
}));
export const boardProjects = read('projects', empty, project.array());
export const boardProject = read('project', z.object({ id: string.min(1) }), detail.nullable());
export const boardSearch = read('search', z.object({ query: string }), z.looseObject({ ref: string, kind: string, project_id: optionalText, ts: optionalText, snippet: string }).array());
export const boardSession = read('session', address.extend({ before: z.int().positive().optional() }), z.object({ session, agent: agent.nullable() }));
export const boardTurn = read('turn', address, turn);
export const boardItem = read('item', address.extend({ offset: z.int().nonnegative() }),
  z.looseObject({ address: string, text: string, total: number, next_offset: number.nullable(), refused: z.boolean(), missing: z.boolean() }));
export const boardWorkspace = read('workspace', z.object({ directory: string, serverId: string.min(1) }), project.array());
export const boardEvidence = read('evidence', z.object({ ref: string }), z.union([
  z.object({ kind: z.enum(['event', 'question']), text: string, detail: optionalText, at: string, project_id: optionalText }),
  z.object({ kind: z.enum(['chunk', 'digest', 'turn']), ref: string, ts_end: optionalText, session: z.object({ short_id: string }).nullable(),
  digest: z.object({ topics: z.object({ label: string, summary: string }).array().optional() }).nullable(),
  chunks: z.object({ id: number, text: string, truncated: z.boolean() }).array(),
})]).nullable());
export const boardChanges = defineSubscription({ name: 'board.changes', input: empty, event: z.enum(['ready', 'events', 'sessions', 'questions', 'status']) });

export type BoardProjectCard = z.output<typeof project>;
