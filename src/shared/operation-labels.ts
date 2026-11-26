import { localTime } from './board-time.ts';
import { STAGE_LABEL } from './vocab.ts';
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
export function opLabel(op: string, fallback = op): string {
  return Object.hasOwn(OP_LABEL, op) ? OP_LABEL[op] : fallback;
}

type Named = { id: string; title: string };
type Written = { id: string; text: string };
type ProjectItems = Named & {
  milestones: Named[]; todos: Named[]; decisions: Written[]; blockers: Written[];
  contributions: { id: string; session_key: string; session: { title: string } | null }[];
};

export function entityNames(projects: Iterable<readonly [string, string]>, detail?: ProjectItems,
  sessions: readonly { key: string; title: string }[] = []): Map<string, string> {
  const names = new Map<string, string>();
  for (const [id, title] of projects) names.set('projects:' + id, title);
  for (const session of sessions) names.set('sessions:' + session.key, session.title);
  if (detail) {
    names.set('projects:' + detail.id, detail.title);
    for (const table of ['milestones', 'todos', 'decisions', 'blockers'] as const) {
      for (const item of detail[table]) names.set(table + ':' + item.id, 'title' in item ? item.title : item.text);
    }
    for (const c of detail.contributions) {
      if (!c.session?.title) continue;
      names.set('sessions:' + c.session_key, c.session.title);
      names.set('contributions:' + c.id, c.session.title);
    }
  }
  return names;
}

const entities: Record<string, string> = { projects: '项目', milestones: '里程碑', todos: '待办', decisions: '决策', blockers: '阻塞', sessions: '会话', contributions: '会话关联' };
const fields: Record<string, string> = { title: '标题', summary: '一句话', why: '为什么', done_criteria: '完成标准', text: '内容', priority: '优先级', stage: '阶段',
  status: '状态', kind: '阻塞类型', position: '排序', milestone_id: '所属里程碑', ref: '核对依据', ts_start: '开始时间', ts_end: '结束时间', confidence: '置信度' };
const values: Record<string, string> = { todo: '待做', doing: '进行中', done: '完成', user: '等你处理', external: '等外部处理', technical: '技术问题' };

function labelFor(labels: Readonly<Record<string, string>>, key: unknown, fallback: string): string {
  return typeof key === 'string' && Object.hasOwn(labels, key) ? labels[key] : fallback;
}

export function entityLabel(ref: string | null, names: ReadonlyMap<string, string>): string {
  if (!ref) return '';
  const table = ref.split(':', 1)[0];
  return names.get(ref) || (table === 'contributions' ? '已取消的会话关联' : '已删除的' + labelFor(entities, table, '条目'));
}

export function actorLabel(actor: string): string {
  if (actor === 'user') return '你';
  if (actor === 'system') return '系统';
  const role = actor.replace(/^ai:/, '');
  const roles: Record<string, string> = { curator: '整理员', decider: '决策员', digest: '摘要员', digester: '摘要员', restage: '复核员', reviewer: '复核员', steward: '总管' };
  return labelFor(roles, role, actor.startsWith('ai:') ? (role ? 'AI（' + role + '）' : 'AI') : actor);
}

export function optionDetailProject(option: QuestionOptionView, owner?: string | null): string | undefined {
  const args = option.args;
  if (!args || !(args.id || args.milestone_id) || args.table === 'projects') return undefined;
  return typeof args.project === 'string' ? args.project : owner ?? undefined;
}

function quoted(text: string): string {
  const chars = Array.from(text);
  return '「' + (chars.length > 40 ? chars.slice(0, 40).join('') + '…' : text) + '」';
}

export function describeOption(o: QuestionOptionView, names: ReadonlyMap<string, string> = new Map()): string {
  if (!o.has_op || !o.op) return '不做任何操作';
  const a = o.args ?? {};
  const name = (table: string, key: unknown) => {
    const title = typeof key === 'string' && names.get(table + ':' + key);
    return title ? quoted(title) : '该' + labelFor(entities, table, '条目');
  };
  const project = name('projects', a.project);
  const scope = a.project ? '在' + project + '中' : '';
  const fieldValue = (key: string, value: unknown): string => {
    if (key === 'milestone_id') return value === null ? '无所属里程碑' : '所属里程碑为' + name('milestones', value);
    if (!Object.hasOwn(fields, key) || (typeof value !== 'string' && typeof value !== 'number' && value !== null)) return '';
    if (key === 'stage' && typeof value === 'string') return '阶段为' + (value === 'idea' ? '想法' : labelFor(STAGE_LABEL, value, '所选阶段'));
    if ((key === 'ts_start' || key === 'ts_end') && typeof value === 'string') return fields[key] + '为' + localTime(value);
    const label = value === null ? '未定' : key === 'kind' || key === 'status' ? labelFor(values, value, '未指定') : quoted(String(value));
    return fields[key] + '设为' + label;
  };
  const edits = (pairs: [string, unknown][]) => pairs.map(([k, v]) => fieldValue(k, v)).filter(Boolean).join('，');
  let sentence: string;
  switch (o.op) {
    case 'transition_stage':
      sentence = a.merge_into ? '把' + project + '合并到' + name('projects', a.merge_into)
        : '把' + project + '的阶段改为' + (a.stage === 'idea' ? '想法' : labelFor(STAGE_LABEL, a.stage, '所选阶段'));
      break;
    case 'create_project': {
      sentence = '新建项目' + (typeof a.title === 'string' ? quoted(a.title) : '');
      const details = edits(Object.entries(a).filter(([key]) => key !== 'title'));
      if (details) sentence += '，' + details;
      if (a.from_session) sentence += '并关联' + name('sessions', a.from_session);
      break;
    }
    case 'update_project':
      sentence = '修改' + project;
      if (a.fields && typeof a.fields === 'object') {
        const changes = edits(Object.entries(a.fields));
        if (changes) sentence += '，' + changes;
      }
      break;
    case 'upsert_milestone': case 'upsert_todo': case 'set_blocker': {
      const table = o.op === 'upsert_milestone' ? 'milestones' : o.op === 'upsert_todo' ? 'todos' : 'blockers';
      sentence = scope + (a.id ? '修改' + name(table, a.id) : '添加' + entities[table]);
      const changes = edits(Object.entries(a));
      if (changes) sentence += '，' + changes;
      break;
    }
    case 'record_decision':
      sentence = scope + '记录决策' + (typeof a.text === 'string' ? quoted(a.text) : '');
      if (typeof a.decided_at === 'string') sentence += '，决策时间为' + localTime(a.decided_at);
      break;
    case 'delete_milestone': case 'delete_todo': case 'delete_blocker': case 'delete_decision':
      sentence = scope + '删除' + name({ delete_milestone: 'milestones', delete_todo: 'todos', delete_blocker: 'blockers', delete_decision: 'decisions' }[o.op], a.id); break;
    case 'clear_blocker': sentence = a.id ? '解除阻塞：' + name('blockers', a.id) : '解除阻塞'; break;
    case 'unlock_field': sentence = '解锁' + name(String(a.table), a.id) + '的' + labelFor(fields, a.field, '字段'); break;
    case 'link_session': {
      sentence = '把' + name('sessions', a.session) + '关联到' + project + (a.milestone_id ? '的里程碑' + name('milestones', a.milestone_id) : '');
      const details = edits(Object.entries(a).filter(([key]) => key !== 'milestone_id'));
      if (details) sentence += '，' + details;
      break;
    }
    case 'unlink_session': sentence = '取消' + name('sessions', a.session) + '与' + project + '的关联'; break;
    case 'ignore_session': sentence = (a.ignored === false ? '恢复跟踪' : '忽略') + name('sessions', a.session); break;
    case 'mark_checked': sentence = '将' + name(String(a.item_type) + 's', a.id) + '标为已核对' + (a.ref ? '，依据为' + a.ref : ''); break;
    case 'apply_merge':
      sentence = '按预览将' + name('projects', a.source) + (a.mode === 'sessions' ? '的会话移到' : '合并到') + name('projects', a.target);
      if (a.mode === 'sessions' && Array.isArray(a.sessions)) sentence += '：' + a.sessions.map(key => name('sessions', key)).join('、');
      if (Array.isArray(a.overwrite_locked) && a.overwrite_locked.length) sentence += '，允许覆盖已锁定的' + a.overwrite_locked.map(key => labelFor(fields, key, '字段')).join('、');
      break;
    case 'revert_event': sentence = '撤销变更'; break;
    default: sentence = '未识别的操作';
  }
  return o.text_arg ? sentence + '（用你的回答填写' + labelFor(fields, o.text_arg.split('.').at(-1), '内容') + '）' : sentence;
}
