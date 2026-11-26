import { useRpc, type PluginScreenProps } from '@getpaseo/plugin/client';
import { useMutation } from '@tanstack/react-query';
import { useRef, useState, type ReactElement } from 'react';

import { askSteward } from '../shared/models.ts';
import { Input } from './board-controls.tsx';
import { Action, Page, Words } from './board-ui.tsx';

export function StewardScreen({ params, navigation }: PluginScreenProps): ReactElement {
  const [question, setQuestion] = useState('');
  const create = useRpc(askSteward);
  const attempt = useRef<{ question: string; key: string } | null>(null);
  const launch = useMutation({ mutationFn: () => {
    // A lost RPC reply can leave a live agent. Retrying the same form should open that agent.
    if (attempt.current?.question !== question) {
      attempt.current = { question, key: 'steward-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) };
    }
    return create({ question, projectId: params.projectId, requestKey: attempt.current.key });
  }, onSuccess: ref => { attempt.current = null; setQuestion(''); navigation?.openAgent(ref); }, retry: false });
  return <Page>
    {params.projectId && <Words tone="heading">{params.projectTitle ?? params.projectId}</Words>}
    <Input label="想问总管什么？可留空查看全局态势" value={question} change={setQuestion} multiline />
    <Action label={launch.isPending ? '正在创建总管…' : '创建总管并提问'} disabled={!navigation || launch.isPending}
      onPress={() => launch.mutate()} />
    {launch.isError && <Words tone="warning">{launch.error.message}</Words>}
  </Page>;
}
