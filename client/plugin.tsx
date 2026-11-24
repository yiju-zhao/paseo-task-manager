import { View } from 'react-native';
import type { PluginTheme, RpcOutput } from '@getpaseo/plugin';
import { useEffect, useState } from 'react';
import { usePaseo, useSettings, useRpc, type PluginClientContext, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import { SettingsRow, SettingsSection, SettingsSwitch } from '@getpaseo/plugin/client/ui';
import type { HostDirectory } from '@getpaseo/client';
import { importProgress, settings } from '../shared/settings.ts';

const description = [
  '关闭时，已关闭和已归档的 session 只采集名称、状态、工作目录等信息。',
  '打开后，两类 session 的历史对话也会进入看板。读取会让 Paseo 从保存的记录加载会话；不会发消息、开始新轮次或产生模型费用。',
  '已关闭、未归档的 session 会从“已关闭”变为“空闲”。Claude 会加载到 daemon 内存，Codex 会启动常驻进程。',
  '已归档的 session 保留归档标记。0.17.3 中两种 provider 的运行状态都可变为“空闲”，读取归档历史后均未留下常驻 provider 进程。',
  '关闭开关会停止后续历史读取，已经入库的内容保留。重启 daemon 会释放加载的会话。',
].join('\n');

function HistoryProgress({ selected, theme }: { selected: string[]; theme: PluginTheme }) {
  const getProgress = useRpc(importProgress);
  const [result, setResult] = useState<RpcOutput<typeof importProgress>>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const state = await getProgress({});
        if (active) { setResult(state); setError(false); }
      } catch { if (active) setError(true); }
      finally { if (active) timer = setTimeout(poll, 2000); }
    }
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [getProgress]);
  if (!selected.length) return <SettingsRow label="请选择要导入的机器" />;
  const sources = result?.sources.filter(s => selected.includes(s.serverId)) ?? [];
  const ready = !error && sources.length === selected.length && sources.every(s => s.ready);
  const completed = sources.reduce((n, s) => n + s.completed, 0);
  const total = sources.reduce((n, s) => n + s.total, 0);
  const percent = total ? Math.floor(100 * completed / total) : ready ? 100 : 0;
  const hint = error ? '暂时读不到进度，正在重试' : !ready ? '等待读取所选机器的完整目录'
    : completed === total ? '历史已导入完成，可以关闭此开关' : '按中心确认的进度更新';
  return <SettingsRow label={`历史导入：${completed} / ${total} 个会话`} hint={hint}>
    <View accessibilityRole="progressbar" accessibilityLabel="历史导入" accessibilityValue={{ min: 0, max: 100, now: percent }}
      style={{ width: 100, height: 6, borderRadius: 3, overflow: 'hidden', backgroundColor: theme.colors.surface2 }}>
      <View style={{ width: `${percent}%`, height: 6, backgroundColor: theme.colors.accent }} />
    </View>
  </SettingsRow>;
}

function CollectionSettings({ theme }: PluginSurfaceProps) {
  const api = usePaseo();
  const prefs = useSettings(settings);
  const [hosts, setHosts] = useState<HostDirectory>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const load = () => api.hosts.list().then(h => { if (active) { setHosts(h); setError(''); } })
      .catch(() => { if (active) setError('读取主机列表失败'); });
    void load();
    const timer = setInterval(load, 10_000);
    return () => { active = false; clearInterval(timer); };
  }, [api]);
  if (prefs.status !== 'ready') return <SettingsRow label={prefs.status === 'loading' ? '读取设置中' : '读取设置失败'} />;
  const { selectedHosts, readClosed } = prefs.values;
  const setHostsSelected = (ids: string[]) => void prefs.save({ selectedHosts: [...new Set(ids)], readClosed }, prefs.revision);
  const known = hosts ? [hosts.self, ...hosts.hosts] : [];
  const ids = known.flatMap(h => h.serverId ? [h.serverId] : []);
  return <>
    <SettingsSection title="采集机器">
      {error && <SettingsRow label={error} />}
      <SettingsSwitch label="全选" disabled={prefs.saving || !ids.length} value={!!ids.length && ids.every(id => selectedHosts.includes(id))}
        onValueChange={on => setHostsSelected(on ? ids : [])} />
      {known.map(h => <SettingsSwitch key={h.serverId ?? ('registrationId' in h ? h.registrationId : h.label)} label={h.label ?? h.serverId ?? '待连接主机'}
        disabled={!h.serverId || prefs.saving} value={!!h.serverId && selectedHosts.includes(h.serverId)}
        onValueChange={on => { if (h.serverId) setHostsSelected(on ? [...selectedHosts, h.serverId] : selectedHosts.filter(id => id !== h.serverId)); }} />)}
    </SettingsSection>
    <SettingsSection title="会话内容">
      <SettingsSwitch label="读取已关闭和已归档 session 的内容" hint={description} disabled={prefs.saving} value={readClosed}
        onValueChange={value => void prefs.save({ selectedHosts, readClosed: value }, prefs.revision)} />
      {readClosed && <HistoryProgress selected={selectedHosts} theme={theme} />}
      {prefs.saveError && <SettingsRow label={prefs.saveError} />}
    </SettingsSection>
  </>;
}
export default function contribute(client: PluginClientContext) {
  return client.addSettingsScreen({ id: 'collection', title: 'agent-pm 采集', icon: 'Database', Component: CollectionSettings });
}
