import { useEffect, useState } from 'react';
import type { RpcOutput } from '@getpaseo/plugin';
import { useRpc } from '@getpaseo/plugin/client';
import { SettingsAction, SettingsRow, SettingsSection } from '@getpaseo/plugin/client/ui';

import { sourceDirectory } from '../shared/settings.ts';

const labels = { ok: '在线', offline: '离线', daemon_down: 'daemon 未连接', never_reported: '尚未上报', retired: '已退役' };

export function SourceSettings() {
  const directory = useRpc(sourceDirectory);
  const [sources, setSources] = useState<RpcOutput<typeof sourceDirectory>>();
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  useEffect(() => {
    if (saving) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const rows = await directory({});
        if (active) {
          setSources(rows);
          setLoadFailed(false);
        }
      } catch {
        if (active) setLoadFailed(true);
      } finally {
        if (active) timer = setTimeout(refresh, 5000);
      }
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [directory, saving]);

  async function change(sourceId: string, retired: boolean) {
    setSaving(true);
    setSaveFailed(false);
    try { setSources(await directory({ change: { sourceId, retired } })); }
    catch { setSaveFailed(true); }
    finally { setSaving(false); }
  }

  return <SettingsSection title="来源">
    {loadFailed && <SettingsRow label="无法读取来源，请检查中心状态" />}
    {saveFailed && <SettingsRow label="来源状态更新失败，请重试" />}
    {sources?.length === 0 && <SettingsRow label="中心尚未记录采集来源" />}
    {sources?.map(source => <SettingsAction key={source.sourceId} label={source.sourceId}
      hint={`${source.kind} · ${source.machine} · ${labels[source.state]} · 最近同步：${source.lastSync ?? '尚未同步'}`}
      actionLabel={source.state === 'retired' ? '恢复' : '标为已退役'} disabled={saving}
      onPress={() => void change(source.sourceId, source.state !== 'retired')} />)}
  </SettingsSection>;
}
