import { useRpc } from '@getpaseo/plugin/client';
import { useMutation } from '@tanstack/react-query';
import { useState, type ReactElement } from 'react';
import { View } from 'react-native';

import { boardProjects, type BoardDetail } from '../shared/board.ts';
import { boardApplyMerge, boardMergePreview, boardPreview } from '../shared/board-writes.ts';
import { Choices, Disclosure, WriteButton } from './board-controls.tsx';
import { Action, Card, row, useBoardQuery, Words } from './board-ui.tsx';

const labels = { title: '标题', summary: '一句话', why: '为什么', done_criteria: '完成标准' } as const;
const coverageLabels: Record<string, string> = { read: '已读', partial: '部分已读', ignored: '已忽略', refused: '拒摘', empty: '无原文' };
const linkLabels: Record<string, string> = { add: '新增', keep: '保留', restore: '恢复', restore_vetoed: '恢复已删除的关联' };

export function MergeEditor({ project }: { project: BoardDetail }): ReactElement {
  const [id, setId] = useState('');
  return <Disclosure label="合并项目">{close => <MergeForm project={project} id={id} setId={setId} close={close} />}</Disclosure>;
}
function MergeForm({ project, id, setId, close }: { project: BoardDetail; id: string; setId(id: string): void; close(): void }): ReactElement {
  const projects = useBoardQuery(boardProjects, {});
  const [target, setTarget] = useState('');
  const [partial, setPartial] = useState(false);
  const [sessions, setSessions] = useState<string[]>([]);
  const [overwrite, setOverwrite] = useState<string[]>([]);
  const start = useRpc(boardPreview);
  const build = useMutation({ mutationFn: async () => {
    const preview = await start({ source: project.id, target, ...(partial ? { sessions } : {}) });
    if (preview.status === 'rejected') throw new Error(preview.message);
    return preview;
  },
    onSuccess: preview => { setId(preview.id); setOverwrite([]); }, retry: false });
  const query = useBoardQuery(boardMergePreview, { id }, !!id);
  const apply = useRpc(boardApplyMerge);
  if (!id) {
    if (projects.isError) return <Words tone="warning">{projects.error.message}</Words>;
    if (!projects.data) return <Words>读取项目中…</Words>;
    if ('reason' in projects.data) return <Words tone="warning">{projects.data.reason}</Words>;
    return <>
      <Choices label="目标项目" value={target} choose={setTarget} choices={projects.data.value.filter(p => p.id !== project.id && p.stage !== 'merged')
        .map(p => ({ value: p.id, label: p.title }))} />
      <View style={row}><Action label="整个项目" selected={!partial} onPress={() => setPartial(false)} />
        <Action label="部分会话" selected={partial} onPress={() => setPartial(true)} /></View>
      {partial && <View style={row}>{project.contributions.map(c => <Action key={c.id} label={c.session?.title || c.session_key}
        selected={sessions.includes(c.session_key)} onPress={() => setSessions(previous => previous.includes(c.session_key)
          ? previous.filter(key => key !== c.session_key) : [...previous, c.session_key])} />)}</View>}
      <Action label={build.isPending ? '正在创建预览…' : '生成合并预览'} disabled={!target || (partial && !sessions.length) || build.isPending}
        onPress={() => build.mutate()} />
      {build.isError && <Words tone="warning">{build.error.message}</Words>}
    </>;
  }
  if (query.isError) return <><Words tone="warning">{query.error.message}</Words><Action label="返回选择" onPress={() => setId('')} /></>;
  const preview = query.data;
  if (!preview || preview.status === 'generating') return <Words>正在读取证据，生成合并预览…</Words>;
  return <><Words tone="heading">{preview.source.title} → {preview.target.title}</Words>
    {preview.error && <Words tone="warning">{preview.error}</Words>}
    {preview.stale && <Words tone="warning">项目或证据已变化，请重新生成预览</Words>}
    {preview.draft && <Card><Words tone="muted">推断 · 截至 {preview.created_at}</Words>
      {(Object.keys(labels) as (keyof typeof labels)[]).map(field => <Words key={field}>{labels[field]} · {preview.draft![field]}</Words>)}
      {preview.draft.title_change_reason && <Words>改名依据 · {preview.draft.title_change_reason}</Words>}
      {preview.draft.unknowns.map((unknown, i) => <Words key={i}>待核实 · {unknown}</Words>)}
      {preview.draft.evidence.map((e, i) => <Words key={i} tone="muted">{e.field} · {e.chunk_ids.map(n => 'chunk:' + n).join('、')}</Words>)}
    </Card>}
    {preview.coverage?.sessions.map(s => <Words key={s.session_key} tone="muted">{preview.session_labels[s.session_key]} · {coverageLabels[s.status]} · {s.chunks_read}/{s.chunks_total} 个片段{s.truncated_chunks > 0 && ' · 截断 ' + s.truncated_chunks}{s.excerpted_chunks > 0 && ' · 节选 ' + s.excerpted_chunks}</Words>)}
    {preview.changes && <>
      <Words>{preview.changes.source_merged ? '来源项目将进入合并阶段' : '来源项目保留，所选会话移至目标'}</Words>
      {preview.changes.links.map(link => <Words key={link.session}>{preview.session_labels[link.session]} · 目标{linkLabels[link.target]}关联</Words>)}
      {preview.changes.fields.map(f => <Card key={f.field}><Words>{labels[f.field]} · {f.before || '空'} → {f.after}</Words>
        {f.locked && <Action label={'允许覆盖已锁定的' + labels[f.field]} selected={overwrite.includes(f.field)}
          onPress={() => setOverwrite(previous => previous.includes(f.field) ? previous.filter(k => k !== f.field) : [...previous, f.field])} />}</Card>)}
      <WriteButton label="应用合并" confirm={'将按这份预览更新「' + preview.target.title + '」，继续？'}
        run={() => apply({ id, overwrite_locked: overwrite })} onSaved={() => { setId(''); close(); }} />
    </>}
    {preview.status === 'applied' && <Words>这份预览已应用</Words>}
    <Action label="重新选择" onPress={() => setId('')} />
  </>;
}
