import { useRpc } from '@getpaseo/plugin/client';
import { useMutation } from '@tanstack/react-query';
import { useState, type ReactElement, type ReactNode } from 'react';
import { TextInput, View } from 'react-native';

import type { RpcInput } from '@getpaseo/plugin';
import { describeOption, entityNames, optionDetailProject } from '../../src/shared/operation-labels.ts';
import { PRIORITIES, STAGES, STAGE_LABEL } from '../../src/shared/vocab.ts';
import { boardDirectory, boardProject, boardProjects, type BoardDetail, type BoardQuestion } from '../shared/board.ts';
import { boardAnswer, boardDismiss, boardOperate } from '../shared/board-writes.ts';
import { Action, Card, row, useBoard, useBoardQuery, Words } from './board-ui.tsx';

export function Input({ label, value, change, multiline = false }: {
  label: string; value: string; change(value: string): void; multiline?: boolean;
}): ReactElement {
  const { theme: { colors } } = useBoard();
  return <View style={{ gap: 3 }}><Words tone="muted">{label}</Words><TextInput accessibilityLabel={label} value={value}
    onChangeText={change} multiline={multiline} style={{ color: colors.foreground, backgroundColor: colors.surface0, borderColor: colors.border,
      borderWidth: 1, borderRadius: 6, padding: 9, minHeight: multiline ? 64 : 38 }} /></View>;
}

export type Choice = { value: string; label: string };
export function Choices({ label, choices, value, choose }: {
  label: string; choices: Choice[]; value: string; choose(value: string): void;
}): ReactElement {
  const [filter, setFilter] = useState('');
  const limit = 12;
  const matches = choices.filter(c => c.label.toLowerCase().includes(filter.trim().toLowerCase()) || c.value === value);
  const shown = matches.slice(0, limit);
  const selected = matches.find(c => c.value === value);
  if (selected && !shown.includes(selected)) shown.push(selected);
  return <View style={{ gap: 5 }}><Words tone="muted">{label}</Words>
    {choices.length > limit && <Input label={'筛选' + label} value={filter} change={setFilter} />}
    <View style={row}>{shown.map(c => <Action key={c.value} label={c.label} selected={value === c.value} onPress={() => choose(c.value)} />)}</View>
    {!shown.length && <Words tone="muted">没有可选项</Words>}
    {matches.length > shown.length && <Words tone="muted">还有 {matches.length - shown.length} 项，请输入名称缩小范围</Words>}
  </View>;
}

type Outcome = { status: string; message?: string; warnings?: string[] } | { ok: true } | { accepted: true };
export function WriteButton({ label, run, confirm, disabled, saved, onSaved }: {
  label: string; run(): Promise<Outcome>; confirm?: string; disabled?: boolean; saved?: string; onSaved?(): void;
}): ReactElement {
  const [confirming, setConfirming] = useState(false);
  const write = useMutation({ mutationFn: async () => {
    const outcome = await run();
    if ('status' in outcome && outcome.status === 'rejected') throw new Error(outcome.message);
    return outcome;
  }, onSuccess: () => { setConfirming(false); onSaved?.(); }, retry: false });
  return <View style={{ gap: 4, alignSelf: 'flex-start', maxWidth: '100%' }}>
    {confirming && <Words tone="warning">{confirm}</Words>}
    <View style={row}><Action label={write.isPending ? '提交中…' : confirming ? '确认' + label : label}
      disabled={disabled || write.isPending} onPress={() => {
        if (confirm && !confirming) { write.reset(); setConfirming(true); }
        else write.mutate();
      }} />
      {confirming && <Action label="取消" disabled={write.isPending} onPress={() => { setConfirming(false); write.reset(); }} />}</View>
    {write.isError && <Words tone="warning">{write.error.message}</Words>}
    {write.isSuccess && saved && <Words tone="muted">{saved}</Words>}
    {write.data && 'warnings' in write.data && write.data.warnings?.map(warning => <Words key={warning} tone="warning">{warning}</Words>)}
  </View>;
}

export function Disclosure({ label, children }: { label: string; children(close: () => void): ReactNode }): ReactElement {
  const [isOpen, setOpen] = useState(false);
  return <View style={{ gap: 6 }}><Action label={isOpen ? '收起' + label : label} selected={isOpen} onPress={() => setOpen(!isOpen)} />
    {isOpen && <Card>{children(() => setOpen(false))}</Card>}</View>;
}

type Field = { name: string; label: string; initial?: string; choices?: Choice[]; numeric?: boolean; nullable?: boolean; multiline?: boolean };
function Fields({ fields, op, args, editing, close }: {
  fields: Field[]; op: RpcInput<typeof boardOperate>['op']; args: Record<string, unknown>; editing?: boolean; close(): void;
}): ReactElement {
  const operate = useRpc(boardOperate);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map(f => [f.name, f.initial ?? ''])));
  // Keep the original values while typing: sending untouched fields would acquire user locks or overwrite a concurrent edit.
  const [original] = useState(values);
  const changed = fields.filter(f => values[f.name] !== original[f.name]);
  return <>{fields.map(field => {
    const change = (value: string) => setValues(prior => ({ ...prior, [field.name]: value }));
    return field.choices ? <Choices key={field.name} label={field.label} choices={field.choices} value={values[field.name]} choose={change} />
      : <Input key={field.name} label={field.label} value={values[field.name]} change={change} multiline={field.multiline} />;
  })}
    <WriteButton label={editing ? '保存修改' : '创建'} disabled={editing && !changed.length} onSaved={close} run={() => {
      const submitted = editing ? changed : fields.filter(f => values[f.name] !== '');
      const patch = Object.fromEntries(submitted.map(f => {
        const value = values[f.name].trim();
        return [f.name, !value && (f.nullable || f.numeric) ? null : f.numeric ? Number(value) : value];
      }));
      return operate({ op, args: op === 'update_project' ? { ...args, fields: patch } : { ...args, ...patch } });
    }} />
  </>;
}

const priority = [{ label: '未定', value: '' }, ...PRIORITIES.map(value => ({ label: value, value }))];
const stages = STAGES.filter(s => s !== 'merged').map(value => ({ value, label: STAGE_LABEL[value] }));
const itemStatuses = [{ value: 'todo', label: '待做' }, { value: 'doing', label: '进行中' }, { value: 'done', label: '完成' }];
const kinds = [{ value: 'technical', label: '技术' }, { value: 'user', label: '等你' }, { value: 'external', label: '等外部' }];
const fieldLabels: Record<string, string> = { title: '标题', summary: '一句话', why: '为什么', done_criteria: '完成标准', priority: '优先级',
  status: '状态', position: '排序', milestone_id: '所属里程碑' };

function Locks({ table, id, locks }: { table: string; id: string; locks: string[] }): ReactElement {
  const operate = useRpc(boardOperate);
  return <View style={row}>{locks.map(field => <WriteButton key={field} label={'解锁' + (fieldLabels[field] ?? field)}
    run={() => operate({ op: 'unlock_field', args: { table, id, field } })} />)}</View>;
}
export function ProjectEditor({ project }: { project?: BoardDetail }): ReactElement {
  const fields: Field[] = (['title', 'summary', 'why', 'done_criteria'] as const).map(name => ({
    name, label: fieldLabels[name], initial: String(project?.[name] ?? ''), multiline: name !== 'title',
  }));
  fields.push({ name: 'priority', label: '优先级', initial: project?.priority ?? '', choices: priority, nullable: true });
  if (!project) fields.push({ name: 'stage', label: '阶段', initial: 'idea', choices: stages });
  return <Disclosure label={project ? '编辑项目' : '新建项目'}>{close => <>
    <Fields fields={fields} op={project ? 'update_project' : 'create_project'} args={project ? { project: project.id } : {}} editing={!!project} close={close} />
    {project && <Locks table="projects" id={project.id} locks={project.locks} />}
  </>}</Disclosure>;
}

export function StageEditor({ project }: { project: BoardDetail }): ReactElement {
  return <Disclosure label="更改阶段">{close => <Fields fields={[{ name: 'stage', label: '阶段', initial: project.stage, choices: stages }]}
    op="transition_stage" args={{ project: project.id }} editing close={close} />}</Disclosure>;
}

type ItemKind = 'milestone' | 'todo' | 'decision' | 'blocker';
const items = {
  milestone: { label: '里程碑', save: 'upsert_milestone', remove: 'delete_milestone' },
  todo: { label: '待办', save: 'upsert_todo', remove: 'delete_todo' },
  decision: { label: '决策', save: 'record_decision', remove: 'delete_decision' },
  blocker: { label: '阻塞', save: 'set_blocker', remove: 'delete_blocker' },
} as const;
type EditableItem = { id: string; title?: string; text?: string; status?: string; kind?: string; priority?: string | null;
  position?: number; milestone_id?: string | null; locks?: string[] };
export function ItemEditor({ project, kind, item }: { project: BoardDetail; kind: ItemKind; item?: EditableItem }): ReactElement {
  const operate = useRpc(boardOperate);
  const spec = items[kind];
  const args = { project: project.id, ...(item ? { id: item.id } : {}) };
  const isTask = kind === 'milestone' || kind === 'todo';
  const fields: Field[] = [{ name: isTask ? 'title' : 'text', label: spec.label + (isTask ? '标题' : '内容'), initial: item?.title ?? item?.text }];
  if (isTask) fields.push({ name: 'status', label: '状态', initial: item?.status ?? 'todo', choices: itemStatuses });
  if (kind === 'milestone') fields.push({ name: 'position', label: '排序', initial: item?.position?.toString(), numeric: true });
  if (kind === 'todo') fields.push({ name: 'priority', label: '优先级', initial: item?.priority ?? '', nullable: true, choices: priority },
    { name: 'milestone_id', label: '所属里程碑', initial: item?.milestone_id ?? '', nullable: true,
      choices: [{ value: '', label: '无' }, ...project.milestones.map(m => ({ value: m.id, label: m.title }))] });
  if (kind === 'blocker') fields.push({ name: 'kind', label: '阻塞类型', initial: item?.kind ?? 'technical', choices: kinds });
  const label = (item ? '管理' : kind === 'decision' ? '记录' : '添加') + spec.label;
  return <Disclosure label={label}>{close => <>
    {(!item || kind !== 'decision') && <Fields fields={fields} op={spec.save} args={args} editing={!!item} close={close} />}
    {item?.locks && <Locks table={kind === 'todo' ? 'todos' : 'milestones'} id={item.id} locks={item.locks} />}
    {kind === 'blocker' && item?.status === 'open' && <WriteButton label="解除阻塞" run={() => operate({ op: 'clear_blocker', args })} onSaved={close} />}
    {item && <WriteButton label={'删除' + spec.label} confirm={'删除「' + (item.title ?? item.text) + '」？'} run={() => operate({ op: spec.remove, args })} onSaved={close} />}
    {kind === 'decision' && item && <ItemEditor project={project} kind="decision" />}
  </>}</Disclosure>;
}

function OptionEffect({ option, owner, project }: { option: BoardQuestion['options'][number]; owner?: string; project?: BoardDetail }): ReactElement {
  const id = optionDetailProject(option, owner);
  const detail = useBoardQuery(boardProject, { id: id ?? '' }, !!id && id !== project?.id);
  const args = option.args;
  const projectRefs = [args?.project, args?.target, args?.source, args?.merge_into, args?.table === 'projects' ? args.id : null];
  const projects = useBoardQuery(boardProjects, {}, projectRefs.some(ref => typeof ref === 'string' && ref !== project?.id));
  const sessions = useBoardQuery(boardDirectory, {}, !!(option.args?.session || option.args?.from_session || option.args?.sessions));
  const current = id && id !== project?.id && detail.data && 'value' in detail.data ? detail.data.value : project;
  const titles = projects.data && 'value' in projects.data ? projects.data.value.map(p => [p.id, p.title] as const) : [];
  const names = entityNames(titles, current ?? undefined, sessions.data && 'value' in sessions.data ? sessions.data.value : []);
  return <Words tone="muted">{describeOption(option, names)}</Words>;
}

export function QuestionActions({ question, project }: { question: BoardQuestion; project?: BoardDetail }): ReactElement {
  const answer = useRpc(boardAnswer);
  const dismiss = useRpc(boardDismiss);
  const [text, setText] = useState('');
  return <View style={{ gap: 6 }}>
    {question.recommended !== null && <Words tone="muted">建议 · {question.options[question.recommended]?.label} {question.recommend_reason}</Words>}
    {question.kind === 'text' && <Input label="你的回答" value={text} change={setText} />}
    {(question.kind === 'text' ? question.options.slice(0, 1) : question.options).map((option, index) => <View key={index} style={{ gap: 3 }}>
      {option.detail && <Words>{option.detail}</Words>}
      <OptionEffect option={option} owner={typeof question.project_id === 'string' ? question.project_id : undefined} project={project} />
      <WriteButton label={question.kind === 'text' ? '提交回答' : option.label} disabled={question.kind === 'text' && !text.trim()}
        run={() => answer({ id: question.id, answer: question.kind === 'text' ? { text } : { option_index: index } })} />
    </View>)}
    <WriteButton label="忽略问题" run={() => dismiss({ id: question.id })} />
  </View>;
}
