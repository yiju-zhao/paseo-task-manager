import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

import { OP_SCHEMAS } from '../../src/domain/ops.ts';
import { MergeApproval, MergeSelection, QuestionAnswer, ReminderSnooze } from '../../src/shared/board-writes.ts';

const id = z.string().min(1);
const identified = z.strictObject({ id });
const empty = z.strictObject({});
const strings = z.array(z.string());
const refusal = z.object({ status: z.literal('rejected'), code: z.string(), message: z.string() });
const operation = z.discriminatedUnion('status', [
  z.object({ status: z.literal('applied'), id: id.optional(), event_id: z.int().nullable(), question_ids: strings, warnings: strings, project_review_queued: z.boolean().optional() }),
  z.object({ status: z.literal('proposed'), question_ids: strings }),
  refusal,
]);
const preview = z.looseObject({
  id, created_at: z.string(), status: z.enum(['generating', 'ready', 'failed', 'applied']), stale: z.boolean(), error: z.string().nullable(),
  source: z.object({ id, title: z.string() }), target: z.object({ id, title: z.string() }),
  session_labels: z.record(id, z.string()),
  changes: z.looseObject({ source_merged: z.boolean(), source_remaining_sessions: strings,
    fields: z.object({ field: z.enum(['title', 'summary', 'why', 'done_criteria']), before: z.string().nullable(), after: z.string(), locked: z.boolean() }).array(),
    links: z.object({ session: id, target: z.string(), source: z.string() }).array() }).nullable(),
  draft: z.looseObject({ title: z.string(), summary: z.string(), why: z.string(), done_criteria: z.string(), unknowns: strings,
    title_change_reason: z.string().nullable(), evidence: z.object({ field: z.string(), chunk_ids: z.int().array() }).array() }).nullable(),
  coverage: z.looseObject({ mode: z.string(), sessions: z.looseObject({ session_key: id, status: z.string(),
    chunks_read: z.int(), chunks_total: z.int(), truncated_chunks: z.int(), excerpted_chunks: z.int() }).array() }).nullable(),
});

export const boardOperate = defineRpc({ name: 'board.operate', input: z.strictObject({ op: z.object(OP_SCHEMAS).omit({ mark_checked: true, apply_merge: true }).keyof(), args: z.record(z.string(), z.unknown()) }), output: operation });
export const boardAnswer = defineRpc({ name: 'board.answer', input: identified.extend({ answer: QuestionAnswer }), output: operation });
export const boardDismiss = defineRpc({ name: 'board.dismiss', input: identified, output: operation });
export const boardSnooze = defineRpc({ name: 'board.snooze', input: ReminderSnooze, output: z.union([z.object({ ok: z.literal(true) }), refusal]) });
export const boardSync = defineRpc({ name: 'board.sync', input: empty, output: z.union([z.object({ accepted: z.literal(true) }), refusal]) });
export const boardPreview = defineRpc({ name: 'board.preview', input: MergeSelection.extend({ source: id }), output: z.union([preview, refusal]) });
export const boardMergePreview = defineRpc({ name: 'board.merge.read', input: identified, output: preview });
export const boardApplyMerge = defineRpc({ name: 'board.merge.apply', input: MergeApproval.extend({ id }), output: operation });
