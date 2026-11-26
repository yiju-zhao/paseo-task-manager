import { useRpc, type PluginSidebarItemProps } from '@getpaseo/plugin/client';
import { SidebarRow } from '@getpaseo/plugin/client/ui';
import { useQuery } from '@tanstack/react-query';
import { useDeferredValue, useEffect, useState, type ReactElement } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';

import { STAGES, STAGE_LABEL, type Stage } from '../../src/shared/vocab.ts';
import { boardOverview, boardProjects, boardQuestions, boardSearch } from '../shared/board.ts';
import { boardSnooze, boardSync } from '../shared/board-writes.ts';
import { ProjectEditor, QuestionActions, WriteButton } from './board-controls.tsx';
import { Action, BoardTime, Card, openAddress, Page, Provenance, Read, row, useBoard, useBoardQuery, Words } from './board-ui.tsx';

export function BoardSidebar({ openScreen, currentScreen, theme }: PluginSidebarItemProps): ReactElement {
  const overview = useBoardQuery(boardOverview, {});
  const count = overview.data && 'value' in overview.data ? overview.data.value.overview.pending.length : undefined;
  return <SidebarRow icon="Columns3" active={currentScreen?.screenId === 'board'} onPress={() => openScreen({ screenId: 'board' })}
    trailing={<Text style={{ color: theme.colors.foregroundMuted }}>{count}</Text>} />;
}

function duration(ms: number | null): string {
  if (ms === null) return '时长未知';
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) return '不足 1 分钟';
  if (minutes < 60) return minutes + ' 分钟';
  return minutes < 1440 ? Math.floor(minutes / 60) + ' 小时' : Math.floor(minutes / 1440) + ' 天';
}

function ProjectBoard() {
  const { layout, theme, openScreen } = useBoard();
  const [stage, setStage] = useState<Stage | 'all'>('all');
  const [query, setQuery] = useState('');
  const term = useDeferredValue(query.trim());
  const hits = useBoardQuery(boardSearch, { query: term }, !!term);
  const projects = useBoardQuery(boardProjects, {}, !term);
  return <>
    <ProjectEditor />
    <TextInput value={query} onChangeText={setQuery} accessibilityLabel="搜索项目、摘要和消息" placeholder="搜索项目、摘要和消息"
      placeholderTextColor={theme.colors.foregroundMuted} style={{ minHeight: 42, paddingHorizontal: 12, borderWidth: 1, borderRadius: 6,
        borderColor: theme.colors.border, color: theme.colors.foreground, backgroundColor: theme.colors.surface1 }} />
    {term ? <Read query={hits}>{matches => matches.length ? matches.map((hit, index) => <Card key={hit.ref + index}>
      <Words>{hit.snippet}</Words><BoardTime prefix={(hit.kind === 'digest' ? '推断' : hit.kind === 'message' ? '记录' : '记录 · 台账摘录') + ' · '} at={hit.ts} />
      <Action label={hit.ref} onPress={() => openAddress(openScreen, hit.ref, hit.project_id)} />
    </Card>) : <Words tone="muted">没有匹配结果</Words>}</Read> : <Read query={projects}>{cards => {
      const stages = STAGES.filter(s => cards.some(p => p.stage === s));
      const columns = stages.filter(s => !layout.compact || stage === 'all' || stage === s).map(s =>
        <View key={s} style={{ gap: 8, width: layout.compact ? '100%' : 260 }}>
          <View style={{ borderTopWidth: 3, borderColor: theme.colors.accent, paddingTop: 8 }}><Words tone="heading">{STAGE_LABEL[s]} · {cards.filter(p => p.stage === s).length}</Words></View>
          {cards.filter(p => p.stage === s).map(p => <Card key={p.id}>
            <Action label={p.title} onPress={() => openScreen({ screenId: 'project', params: { id: p.id } })} />
            {p.summary && <Words>{p.summary}</Words>}
            <Provenance actor={p.locks.includes('summary') ? 'user' : p.created_by} at={p.last_activity_at} />
            <Words tone="muted">{p.priority ?? '优先级未定'} · {p.open_todos.length} 项待办 · {p.open_blockers.length} 项阻塞</Words>
          </Card>)}
        </View>);
      if (!cards.length) return <Words tone="muted">还没有项目</Words>;
      return layout.compact ? <><View style={row}>{(['all', ...stages] as const).map(s =>
        <Action key={s} label={s === 'all' ? '全部阶段' : STAGE_LABEL[s]} selected={stage === s} onPress={() => setStage(s)} />)}</View>{columns}</>
        : <ScrollView horizontal contentContainerStyle={{ gap: 14, alignItems: 'flex-start' }}>{columns}</ScrollView>;
    }}</Read>}
  </>;
}

const tabs = ['待处理', '实时', '看板', '来源'] as const;
export function BoardScreen(): ReactElement {
  const [tab, setTab] = useState<typeof tabs[number]>('待处理');
  const { host, navigation, openScreen } = useBoard();
  const overview = useBoardQuery(boardOverview, {});
  const read = useRpc(boardOverview);
  const snooze = useRpc(boardSnooze);
  const sync = useRpc(boardSync);
  const questions = useBoardQuery(boardQuestions, {}, tab === '待处理');
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (tab !== '待处理' && tab !== '实时') return;
    setClock(Date.now());
    const minute = setInterval(() => setClock(Date.now()), 60_000);
    return () => clearInterval(minute);
  }, [tab]);
  const elapsed = Math.max(0, clock - overview.dataUpdatedAt);
  // Only opening the board consumes the panel cursor. Background refreshes and sidebar reads share a separate query.
  const since = useQuery({ queryKey: ['panel-visit', host.id], queryFn: () => read({ markRead: true }),
    enabled: !!overview.data && 'value' in overview.data, staleTime: Infinity, gcTime: 0, refetchOnMount: 'always', retry: false });
  return <Page>
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}><View style={{ ...row, flex: 1 }}>{tabs.map(t => <Action key={t} label={t} selected={tab === t} onPress={() => setTab(t)} />)}<WriteButton label="立即同步" run={() => sync({})} saved="已请求同步" /></View>
      <Action label="问总管" onPress={() => openScreen({ screenId: 'ask-steward' })} /></View>
    {tab === '看板' ? <ProjectBoard /> : <Read query={overview}>{({ overview: snapshot, targets, at, machines, usage }) => {
      if (tab === '待处理') return <>
        <Words tone="title">待处理 · {snapshot.pending.length}</Words>
        {!snapshot.pending.length && <Words tone="muted">当前没有待处理事项</Words>}
        {snapshot.pending.map((p) => {
          const target = targets[p.ref];
          const reminder = p.reminder_key;
          return <Card key={reminder ?? p.ref}><Words>{p.text}</Words><Words tone="muted">已等待 {duration(p.since ? Date.parse(at) - Date.parse(p.since) + elapsed : null)}</Words>
            <View style={row}>{target?.project && <Action label="打开项目" onPress={() => openAddress(openScreen, target.project!)} />}
              {target?.address && <Action label={target.address} onPress={() => openAddress(openScreen, target.address!)} />}
              {target?.agent && navigation && <Action label="在 Paseo 里打开" onPress={() => navigation.openAgent(target.agent!)} />}</View>
            {reminder ? <View style={row}><WriteButton label="明天再提醒" run={() => snooze({ key: reminder, hours: 24 })} />
              <WriteButton label="不再提醒" confirm="直到这条提醒的内容变化再显示？" run={() => snooze({ key: reminder, hours: null })} /></View>
              : <Read query={questions}>{pending => {
                const question = pending.find(q => q.id === p.ref);
                return question && <QuestionActions question={question} />;
              }}</Read>}
          </Card>;
        })}
        <Words tone="heading">自上次以来</Words>
        <Read query={since}>{({ overview: visit }) => {
          const changes = new Map(visit.changes.map(c => [c.project_id, c]));
          // The live overview starts at the cursor acknowledged by this visit.
          if (snapshot.last_event_id > visit.last_event_id) for (const c of snapshot.changes) {
            const prior = changes.get(c.project_id);
            changes.set(c.project_id, prior ? {
              project_title: c.project_title, project_id: c.project_id, stages: prior.stages + c.stages, decisions: prior.decisions + c.decisions,
              completed_todos: prior.completed_todos + c.completed_todos, new_blockers: prior.new_blockers + c.new_blockers,
              cleared_blockers: prior.cleared_blockers + c.cleared_blockers,
            } : c);
          }
          return changes.size ? [...changes.values()].map(c => <Card key={c.project_id}>
          <Action label={c.project_title} onPress={() => openAddress(openScreen, c.project_id)} />
          <Words>阶段变更 {c.stages} · 新决策 {c.decisions} · 完成待办 {c.completed_todos} · 新阻塞 {c.new_blockers} · 解除 {c.cleared_blockers}</Words>
        </Card>) : <Words tone="muted">没有新的项目变更</Words>;
        }}</Read>
      </>;
      if (tab === '实时') return <>
        <Words tone="title">运行中 · {snapshot.running.length}</Words>
        {!snapshot.running.length && <Words tone="muted">当前没有运行中的会话</Words>}
        {[...new Set(snapshot.running.map(s => s.machine))].map(machine => <View key={machine} style={{ gap: 8 }}>
          <Words tone="heading">{machine}</Words>{snapshot.running.filter(s => s.machine === machine).map(s => <Card key={s.address}>
            <Words>{s.projects.join('、') || '未关联项目'}</Words><Words tone="muted">第 {s.turn ?? '—'} 轮 · 已运行 {duration(s.age_ms === null ? null : s.age_ms + elapsed)}</Words>
            {s.user && <Words>{s.user}</Words>}<Action label={s.address} onPress={() => openAddress(openScreen, s.address)} />
          </Card>)}</View>)}
      </>;
      const states: Record<string, string> = { ok: '正常', offline: '离线', never_reported: '尚未上报', daemon_down: 'daemon 离线' };
      return <><Words tone="title">来源 · {machines.length}</Words>
        {machines.map(s => <Card key={s.id}><Words tone="heading">{s.machine}</Words><Words>{states[s.state]} · {s.id}</Words>{s.last_sync && <BoardTime prefix="最近同步 · " at={s.last_sync} />}</Card>)}
        <Words tone="heading">摘要覆盖</Words><Words>待摘要会话 {snapshot.undigested} · 拒摘窗口 {snapshot.refusals}</Words>
        {usage && <><Words tone="heading">工具详情用量</Words><Words>{(usage.used / 1048576).toFixed(2)} MiB / {(usage.limit / 1048576).toFixed(0)} MiB</Words>
          <BoardTime prefix="最早保留 " at={usage.oldest} empty="暂无" suffix={usage.blocked ? ' · 清理后仍超限' : ''} /></>}
      </>;
    }}</Read>}
  </Page>;
}
