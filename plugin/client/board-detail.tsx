import { useRpc, useWorkspace, type PluginScreenProps, type PluginWorkspacePanelProps } from '@getpaseo/plugin/client';
import { useState, type ReactElement, type ReactNode } from 'react';
import { View } from 'react-native';

import { opLabel } from '../../src/shared/operation-labels.ts';
import { STAGE_LABEL } from '../../src/shared/vocab.ts';
import { boardEvidence, boardItem, boardProject, boardSession, boardTurn, boardWorkspace, type BoardProjectCard } from '../shared/board.ts';
import { boardOperate } from '../shared/board-writes.ts';
import { ItemEditor, ProjectEditor, QuestionActions, StageEditor, WriteButton } from './board-controls.tsx';
import { LinkEditor } from './board-links.tsx';
import { MergeEditor } from './board-merge.tsx';
import { Action, Card, openAddress, Page, Read, row, sourceLabel, useBoard, useBoardQuery, Words } from './board-ui.tsx';

function Reference({ address }: { address: string }) {
  const { openScreen } = useBoard();
  const [isOpen, setOpen] = useState(false);
  const evidence = useBoardQuery(boardEvidence, { ref: address }, isOpen);
  return <View style={{ gap: 6 }}><Action label={address} onPress={() => address.startsWith('s:') ? openAddress(openScreen, address) : setOpen(!isOpen)} />
    {isOpen && <Read query={evidence}>{source => !source ? <Words tone="muted">找不到这条证据</Words> : 'text' in source ? <Card>
      <Words>{source.text}</Words>{source.detail && <Words>{source.detail}</Words>}<Words tone="muted">记录 · {source.at}</Words>
      {source.project_id && <Action label="打开来源项目" onPress={() => openAddress(openScreen, source.project_id!)} />}
    </Card> : <Card>
      {source.digest?.topics?.map((t, index) => <Words key={index}>{t.label} · {t.summary}</Words>)}
      <Words tone="muted">{source.digest ? '推断' : '记录'} · 截至 {source.ts_end ?? '时间未知'}</Words>
      {source.chunks.map(c => <Words key={c.id}>{c.text}{c.truncated ? '…' : ''}</Words>)}
      {source.session && <Action label="打开来源会话" onPress={() => openAddress(openScreen, 's:' + source.session!.short_id)} />}
    </Card>}</Read>}
  </View>;
}

const statusLabel: Record<string, string> = {
  todo: '待做', doing: '进行中', done: '完成', open: '未解除', cleared: '已解除', working: '运行中', blocked: '等待操作',
  idle: '空闲', offline: '离线', ended: '已结束', purged: '已清除', user: '用户', assistant: '助手', tool: '工具',
};
type LedgerRow = { id: string; created_at: string; created_by: string; checked_at?: string | null; checked_ref?: string | null };
function LedgerEntry({ entry, title, status, evidence = [], children }: { children?: ReactNode; entry: LedgerRow; title: string; status?: string; evidence?: string[] }) {
  return <Card><Words>{title}</Words><Words tone="muted">{status ? (statusLabel[status] ?? status) + ' · ' : ''}{sourceLabel(entry.created_by, entry.created_at, entry.checked_at)}</Words>
    {[...new Set([...evidence, ...(entry.checked_ref ? [entry.checked_ref] : [])])].map(ref => <Reference key={ref} address={ref} />)}{children}</Card>;
}

function ProjectBrief({ project }: { project: BoardProjectCard }): ReactElement {
  const { layout } = useBoard();
  const fields = [['summary', '简报'], ['why', '为什么'], ['done_criteria', '完成标准']] as const;
  return <>
    <Words tone="title">{project.title}</Words><Words tone="muted">{STAGE_LABEL[project.stage]} · {project.priority ?? '优先级未定'}</Words>
    <View style={{ flexDirection: layout.compact ? 'column' : 'row', gap: 12 }}>
      {fields.map(([field, label]) => project[field] && <View key={field} style={{ flexGrow: 1, flexBasis: layout.compact ? 'auto' : 0 }}>
        <Card><Words tone="heading">{label}</Words><Words>{project[field]}</Words>
          <Words tone="muted">{sourceLabel(project.locks.includes(field) ? 'user' : project.created_by, project.last_activity_at)}</Words></Card>
      </View>)}
    </View>
  </>;
}

export function ProjectScreen({ params }: PluginScreenProps): ReactElement {
  const operate = useRpc(boardOperate);
  const project = useBoardQuery(boardProject, { id: params.id });
  const { openScreen } = useBoard();
  return <Page><Read query={project}>{p => {
    if (!p) return <Words>找不到这个项目</Words>;
    const sessions = new Map(p.contributions.flatMap(c => c.session ? [[c.session.short_id, c.session] as const] : []));
    return <>
      <ProjectBrief project={p} />
      <ProjectEditor project={p} /><StageEditor project={p} />{p.stage !== 'merged' && <MergeEditor project={p} />}
      <Words tone="heading">等你的事 · {p.pending_questions.length + p.open_blockers.filter(b => b.kind === 'user').length}</Words>
      {p.pending_questions.map(q => <Card key={q.id}><Words>{q.prompt}</Words>{q.context && <Words>{q.context}</Words>}
        <Words tone="muted">{sourceLabel(q.created_by, q.created_at)}</Words>{q.evidence.map(ref => <Reference key={ref} address={ref} />)}<QuestionActions question={q} /></Card>)}
      {p.open_blockers.filter(b => b.kind === 'user').map(b => <LedgerEntry key={b.id} entry={b} title={b.text} />)}
      <Words tone="heading">里程碑 · {p.milestones.length}</Words>
      <ItemEditor project={p} kind="milestone" />
      {p.milestones.map(m => <LedgerEntry key={m.id} entry={m} title={m.title} status={m.status}>
        <ItemEditor project={p} kind="milestone" item={m} /></LedgerEntry>)}
      <Words tone="heading">待办 · {p.todos.length}</Words><ItemEditor project={p} kind="todo" />
      {p.todos.map(t => <LedgerEntry key={t.id} entry={t} title={t.title} status={t.status}>
        <ItemEditor project={p} kind="todo" item={t} /></LedgerEntry>)}
      <Words tone="heading">决策 · {p.decisions.length}</Words><ItemEditor project={p} kind="decision" />
      {p.decisions.map(d => <LedgerEntry key={d.id} entry={d} title={d.text} evidence={d.evidence}>
        <ItemEditor project={p} kind="decision" item={d} /></LedgerEntry>)}
      <Words tone="heading">阻塞 · {p.blockers.length}</Words><ItemEditor project={p} kind="blocker" />
      {p.blockers.map(b => <LedgerEntry key={b.id} entry={b} title={b.text} status={b.status}>
        <ItemEditor project={p} kind="blocker" item={b} /></LedgerEntry>)}
      <Words tone="heading">关联会话 · {sessions.size}</Words><LinkEditor project={p} />{[...sessions.values()].map(s => <Card key={s.short_id}>
        <Action label={s.title || s.short_id} onPress={() => openAddress(openScreen, 's:' + s.short_id)} /><Words tone="muted">{s.machine} · {statusLabel[s.effective_status] ?? s.effective_status}</Words>
      </Card>)}
      <Words tone="heading">时间线</Words>
      {[...p.events.map(e => ({ undo: e.reverted_by === null ? e.id : null, key: 'e' + e.id, at: e.occurred_at, text: [opLabel(e.op), e.entity, e.reason].filter(Boolean).join(' · '),
        source: '记录 #' + e.id + ' · ' + e.actor + ' · ' + e.occurred_at + (e.reverted_by ? ' · 已被 #' + e.reverted_by + ' 撤销' : '') + (e.reverts ? ' · 撤销了 #' + e.reverts : ''), refs: e.evidence })),
        ...p.contributions.map(c => ({ undo: null, key: c.id, at: c.ts_end ?? c.created_at, text: c.summary ?? '关联会话',
          source: sourceLabel(c.actor, c.ts_end ?? c.created_at), refs: c.session ? ['s:' + c.session.short_id] : [] }))].sort((a, b) => b.at.localeCompare(a.at)).map(e =>
        <Card key={e.key}><Words>{e.text}</Words><Words tone="muted">{e.source}</Words>{e.refs.map(ref => <Reference key={ref} address={ref} />)}
          {e.undo && <WriteButton label="撤销变更" confirm={'撤销「' + e.text + '」？'} run={() => operate({ op: 'revert_event', args: { event_id: e.undo } })} />}</Card>)}
    </>;
  }}</Read></Page>;
}

export function SessionScreen({ params }: PluginScreenProps): ReactElement {
  const { navigation, openScreen } = useBoard();
  const [before, setBefore] = useState<number>();
  const query = useBoardQuery(boardSession, { address: params.address, before });
  return <Page><Read query={query}>{({ session: s, agent, ignored, links }) => <>
    <Words tone="title">{s.title || s.address}</Words><Words tone="muted">{s.address} · {s.machine} · {statusLabel[s.status] ?? s.status} · {s.projects.join('、') || '未关联项目'}</Words>
    {agent && navigation && <Action label="在 Paseo 里打开" onPress={() => navigation.openAgent(agent)} />}
    <LinkEditor sessionKey={s.key} ignored={ignored} links={links} />
    <Words tone="heading">会话卡片</Words>
    {s.card ? <Card><Words tone="muted">推断 · {s.card_as_of_turn === null ? '截至轮次未知' : '截至第 ' + s.card_as_of_turn + ' 轮'}</Words>
      {Object.entries({ '目标': s.card.goal, '进展': s.card.state, '等待': s.card.waiting_on, '下一步': s.card.next, '备注': s.card.note })
        .map(([label, value]) => value && <Words key={label}>{label} · {value}</Words>)}</Card> : <Words tone="muted">尚无会话卡片</Words>}
    <Words tone="heading">{s.no_turn_index ? '历史摘要' : '回合大纲'}</Words>
    {s.no_turn_index && <Words tone="muted">此会话尚无回合索引</Words>}
    {s.digests.map(d => <Card key={d.id}><Words tone="muted">推断 · 截至 {d.ts_end ?? '时间未知'}</Words><Reference address={'digest:' + d.id} /></Card>)}
    {s.turns.map(t => <Card key={t.n}><Action label={'第 ' + t.n + ' 轮' + (t.in_progress ? ' · 进行中' : '')} onPress={() => openAddress(openScreen, t.address)} />
      {t.user && <Words>用户 · {t.user}</Words>}{t.assistant && <Words>助手 · {t.assistant}</Words>}
      <Words tone="muted">记录 · 工具 {t.tool_calls} 次 · 失败 {t.tool_failures} 次{t.refused ? ' · 含拒摘内容' : ''}</Words>
    </Card>)}
    <View style={row}>{(s.earlier > 0 || s.earlier_digests > 0) && <Action label="更早的记录" onPress={() => setBefore(s.no_turn_index ? s.digests.at(-1)!.id : s.turns[0].n)} />}
      {before !== undefined && <Action label="回到最新" onPress={() => setBefore(undefined)} />}</View>
  </>}</Read></Page>;
}

function ItemText({ address }: { address: string }) {
  const [offset, setOffset] = useState(0);
  const query = useBoardQuery(boardItem, { address, offset });
  return <Read query={query}>{page => <><Words>{page.text}</Words>
    <View style={row}>{offset > 0 && <Action label="回到开头" onPress={() => setOffset(0)} />}
      {page.next_offset !== null && <Action label="下一页原文" onPress={() => setOffset(page.next_offset!)} />}</View></>}</Read>;
}
export function TurnScreen({ params }: PluginScreenProps): ReactElement {
  const [expanded, setExpanded] = useState<string | undefined>(params.item);
  const query = useBoardQuery(boardTurn, { address: params.address });
  return <Page><Read query={query}>{turn => <><Words tone="title">第 {turn.address.split('#')[1]} 轮</Words><Words tone="muted">记录 · {turn.address}</Words>
    {turn.items.map(item => <Card key={item.address}><Words tone="heading">{item.tool?.name ?? statusLabel[item.kind] ?? item.kind}</Words>
      <Words tone="muted">{item.address}{item.refused ? ' · 曾被拒摘' : ''}</Words>
      <Words>{item.tool ? [item.tool.status, item.tool.input, item.detail].filter(Boolean).join(' · ') : item.text}</Words>
      {(item.tool || item.cleared) && <Action label={expanded === item.address ? '收起原文' : '查看工具原文'} onPress={() => setExpanded(expanded === item.address ? undefined : item.address)} />}
      {expanded === item.address && <ItemText key={item.address} address={item.address} />}
    </Card>)}</>}</Read></Page>;
}

export function WorkspacePanel({ workspaceId, host }: PluginWorkspacePanelProps): ReactElement {
  const directory = useWorkspace(workspaceId, workspace => workspace.directory);
  const { openScreen } = useBoard();
  const query = useBoardQuery(boardWorkspace, { directory: directory ?? '', serverId: host.id }, directory !== null);
  return <Page><Read query={query}>{projects => projects.length ? projects.map(p => <View key={p.id} style={{ gap: 10 }}>
    <ProjectBrief project={p} />
    {p.current_milestone && <Words>当前里程碑 · {p.current_milestone.title}</Words>}
    <Action label="打开项目页" onPress={() => openScreen({ screenId: 'project', params: { id: p.id } })} />
    <Words tone="heading">未完成待办 · {p.open_todos.length}</Words>{p.open_todos.map(t => <LedgerEntry key={t.id} entry={t} title={t.title} status={t.status} />)}
    <Words tone="heading">阻塞 · {p.open_blockers.length}</Words>{p.open_blockers.map(b => <LedgerEntry key={b.id} entry={b} title={b.text} />)}
  </View>) : <Words>这个工作区还没有关联的项目</Words>}</Read></Page>;
}
