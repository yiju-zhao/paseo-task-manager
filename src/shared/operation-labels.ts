import type { QuestionOptionView } from '../domain/read.ts';

// One entry per key of OP_SCHEMAS (src/domain/ops.ts); tests/web/format.test.ts fails when an operation is missing.
export const OP_LABEL: Record<string, string> = {
  create_project: '新建项目',
  update_project: '修改项目',
  transition_stage: '改阶段',
  unlock_field: '解锁字段',
  upsert_milestone: '编辑里程碑',
  upsert_todo: '编辑 todo',
  mark_checked: '核对条目',
  record_decision: '记录决策',
  set_blocker: '设置阻塞',
  delete_milestone: '删除里程碑',
  delete_todo: '删除 todo',
  delete_decision: '删除决策',
  delete_blocker: '删除阻塞',
  clear_blocker: '解除阻塞',
  link_session: '关联 session',
  unlink_session: '取消关联',
  ignore_session: '不追踪 session',
  revert_event: '撤销',
  apply_merge: '合并（经预览确认）',
};

/** The Chinese name of an operation; one we have no name for is shown as the server wrote it. */
export function opLabel(op: string): string {
  return Object.hasOwn(OP_LABEL, op) ? OP_LABEL[op] : op;
}

const MAX_ARG_CHARS = 40;

function argText(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  // Counted in characters, so an emoji is not cut in half.
  const chars = Array.from(text);
  return chars.length > MAX_ARG_CHARS ? `${chars.slice(0, MAX_ARG_CHARS).join('')}…` : text;
}

/** What answering with this option would do, in words: the operation and its arguments, or that it does nothing. */
export function describeOption(o: QuestionOptionView): string {
  if (!o.has_op || o.op === null) return '不做任何操作';
  const args = Object.entries(o.args ?? {}).map(([key, value]) => `${key}=${argText(value)}`);
  const text = [opLabel(o.op), ...args].join(' ');
  return o.text_arg === undefined ? text : `${text}（填入 ${o.text_arg}）`;
}
