import type { PluginRpcContract, SubscriptionEvent } from '@getpaseo/plugin';
import { useRpc, useSubscription, type PluginClientContext, type PluginHostProps, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import { useQuery, useQueryClient, type QueryFilters, type UseQueryResult } from '@tanstack/react-query';
import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { z } from 'zod';

import { boardChanges, boardOverview } from '../shared/board.ts';

type BoardNavigation = Pick<PluginClientContext, 'openScreen' | 'openSettings'>;
type Surface = PluginHostProps & BoardNavigation & Pick<PluginSurfaceProps, 'navigation'>;
const BoardContext = createContext<Surface | null>(null);
export const useBoard = (): Surface => useContext(BoardContext)!;

const affected: Record<Exclude<SubscriptionEvent<typeof boardChanges>, 'ready'>, readonly string[]> = {
  events: ['overview', 'projects', 'project', 'workspace', 'search', 'session', 'questions', 'merge.read'],
  sessions: ['overview', 'projects', 'project', 'workspace', 'session', 'turn', 'item', 'search', 'evidence', 'merge.read', 'directory'],
  questions: ['overview', 'projects', 'project', 'workspace', 'questions'],
  status: ['merge.read', 'overview', 'session', 'turn', 'item', 'search', 'evidence'],
};
export function BoardSurface({ surface, children }: { surface: Surface; children: ReactNode }): ReactElement {
  const cache = useQueryClient();
  useSubscription(boardChanges, {}, change => {
    const matching: QueryFilters = { queryKey: ['task-board', surface.host.id],
      predicate: q => change === 'ready' || affected[change].includes(String(q.queryKey[2])) };
    // Even a first read can be in flight with an older snapshot when the last preview notification arrives.
    void cache.cancelQueries(matching).then(() => cache.invalidateQueries(matching, { cancelRefetch: false }));
  });
  return <BoardContext.Provider value={surface}>{children}</BoardContext.Provider>;
}

export function useBoardQuery<I extends z.ZodType, O extends z.ZodType>(
  contract: PluginRpcContract<I, O>, input: Parameters<ReturnType<typeof useRpc<I, O>>>[0], isEnabled = true,
): UseQueryResult<z.output<O>> {
  const rpc = useRpc(contract);
  const { host } = useBoard();
  return useQuery({ queryKey: ['task-board', host.id, contract.name.slice('board.'.length), input],
    queryFn: () => rpc(input), enabled: isEnabled, staleTime: Infinity, retry: false });
}

export function Words({ children, tone = 'normal' }: { children: ReactNode; tone?: 'normal' | 'title' | 'heading' | 'muted' | 'warning' }): ReactElement {
  const { theme: { colors } } = useBoard();
  const size = { normal: 15, title: 25, heading: 18, muted: 13, warning: 14 }[tone];
  return <Text style={{ color: tone === 'muted' ? colors.foregroundMuted : tone === 'warning' ? colors.statusWarning : colors.foreground,
    fontSize: size, lineHeight: size + 7, fontWeight: tone === 'heading' || tone === 'title' ? '600' : '400' }}>{children}</Text>;
}
export function Action({ label, onPress, selected = false, disabled = false }: { disabled?: boolean; label: string; onPress(): void; selected?: boolean }): ReactElement {
  const { theme: { colors } } = useBoard();
  return <Pressable accessibilityRole="button" accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress}
    style={{ opacity: disabled ? 0.5 : 1, alignSelf: 'flex-start', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: selected ? colors.accent : colors.surface2 }}>
    <Text style={{ color: selected ? colors.accentForeground : colors.foreground, fontSize: 14 }}>{label}</Text>
  </Pressable>;
}
export function Card({ children }: { children: ReactNode }): ReactElement {
  const { theme: { colors } } = useBoard();
  return <View style={{ gap: 6, padding: 14, borderWidth: 1, borderColor: colors.border, borderRadius: 9, backgroundColor: colors.surface1 }}>{children}</View>;
}
export function Page({ children }: { children: ReactNode }): ReactElement {
  const { layout, theme } = useBoard();
  const overview = useBoardQuery(boardOverview, {});
  return <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
    contentContainerStyle={{ padding: layout.compact ? 12 : 24, gap: 14 }}>
    <Read query={overview}>{({ overview: status, excluded, machines, contentGaps, incomplete }) => {
      const warnings = [
        !machines.length && '尚未采集任何机器', excluded > 0 && excluded + ' 台机器未打开采集',
        status.sources.length > 0 && status.sources.length + ' 个来源异常',
        contentGaps > 0 && contentGaps + ' 处时间线缺口', incomplete > 0 && incomplete + ' 条来源观察内容未就绪',
        status.undigested > 0 && status.undigested + ' 个会话待摘要', status.refusals > 0 && status.refusals + ' 段被拒摘',
      ].filter(Boolean);
      return <>{warnings.length > 0 && <Words tone="warning">采集盲区 · {warnings.join(' · ')}</Words>}{children}</>;
    }}</Read>
  </ScrollView>;
}

export function Read<V>({ query, children }: { query: UseQueryResult<{ value: V } | { reason: string }>; children(value: V): ReactNode }): ReactElement {
  const { openSettings } = useBoard();
  if (query.isError) return <Card><Words tone="warning">{query.error.message}</Words><Action label="重试" onPress={() => void query.refetch()} /></Card>;
  if (!query.data) return <Words tone="muted">读取中…</Words>;
  if ('reason' in query.data) return <Card><Words tone="heading">中心未启动</Words><Words>{query.data.reason}</Words>
    <Action label="打开插件设置" onPress={() => openSettings('collection')} /></Card>;
  return <>{children(query.data.value)}</>;
}
export function sourceLabel(actor: string, at: string | null, checkedAt?: string | null): string {
  return (actor === 'user' || checkedAt ? '确认' : '推断') + ' · 截至 ' + (checkedAt ?? at ?? '时间未知').replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
    + (checkedAt ? ' · 已核对' : '');
}
export function openAddress(openScreen: BoardNavigation['openScreen'], address: string, project?: string | null): void {
  if (!address.startsWith('s:')) {
    openScreen({ screenId: 'project', params: { id: project ?? address } });
    return;
  }
  const [session, ordinal] = address.split('#');
  if (!ordinal) openScreen({ screenId: 'session', params: { address: session } });
  else openScreen({ screenId: 'turn', params: { address: session + '#' + ordinal.split('.')[0], ...(ordinal.includes('.') ? { item: address } : {}) } });
}
export const row = { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' } as const;
