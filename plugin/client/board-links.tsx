import { useRpc } from '@getpaseo/plugin/client';
import { useState, type ReactElement } from 'react';
import { View } from 'react-native';

import { boardDirectory, boardProjects, type BoardDetail } from '../shared/board.ts';
import { boardOperate } from '../shared/board-writes.ts';
import { Choices, Disclosure, WriteButton } from './board-controls.tsx';
import { Action, Read, row, useBoardQuery, Words } from './board-ui.tsx';

type Link = { id: string; title: string };
export function LinkEditor({ project, sessionKey, links = [], ignored = false }: {
  project?: BoardDetail; sessionKey?: string; links?: Link[]; ignored?: boolean;
}): ReactElement {
  return <Disclosure label={project ? '管理关联会话' : '管理项目关联'}>{close =>
    <LinkForm project={project} sessionKey={sessionKey} links={links} ignored={ignored} close={close} />}</Disclosure>;
}
function LinkForm({ project, sessionKey, links, ignored, close }: {
  project?: BoardDetail; sessionKey?: string; links: Link[]; ignored: boolean; close(): void;
}): ReactElement {
  const projects = useBoardQuery(boardProjects, {}, !project);
  const directory = useBoardQuery(boardDirectory, {}, !!project);
  const [selected, select] = useState('');
  const [milestone, setMilestone] = useState('');
  const operate = useRpc(boardOperate);
  const existing = project ? project.contributions.map(c => ({ id: c.session_key, title: c.session?.title || c.session_key })) : links;
  const target = project?.id ?? selected;
  const session = sessionKey ?? selected;
  const isIgnored = sessionKey ? ignored : directory.data && 'value' in directory.data && directory.data.value.find(s => s.key === selected)?.ignored;
  const isLinked = existing.some(link => link.id === selected);
  return <>
    {project ? <Read query={directory}>{sessions => <Choices label="会话" value={selected} choose={select}
      choices={sessions.map(s => ({ value: s.key, label: (s.title || s.short_id) + ' · ' + s.machine + ' · ' + s.short_id }))} />}</Read>
      : <Read query={projects}>{cards => <Choices label="项目" value={selected} choose={id => { select(id); setMilestone(''); }}
        choices={cards.filter(p => p.stage !== 'merged').map(p => ({ value: p.id, label: p.title }))} />}</Read>}
    {project && selected && !isLinked && <Choices label="关联到里程碑" value={milestone} choose={setMilestone}
      choices={[{ value: '', label: '整个项目' }, ...project.milestones.map(m => ({ value: m.id, label: m.title }))]} />}
    <WriteButton label={isLinked ? '取消关联' : '关联'} disabled={!selected} onSaved={close}
      confirm={isLinked ? '取消所选项目与会话的关联？' : undefined}
      run={() => operate({ op: isLinked ? 'unlink_session' : 'link_session', args: { project: target, session,
        ...(!isLinked && milestone ? { milestone_id: milestone } : {}) } })} />
    {existing.length > 0 && <><Words tone="muted">已有的关联</Words><View style={row}>{existing.map(link =>
      <Action key={link.id} label={link.title} onPress={() => select(link.id)} selected={selected === link.id} />)}</View></>}
    {session && <WriteButton label={isIgnored ? '恢复会话跟踪' : '忽略会话'} confirm={isIgnored ? undefined : '忽略后，中心停止整理这个会话。'} onSaved={close}
      run={() => operate({ op: 'ignore_session', args: { session, ignored: !isIgnored } })} />}
  </>;
}
