import { useEffect, useState } from 'react';
import { useRpc } from '@getpaseo/plugin/client';
import { SettingsAction, SettingsInput, SettingsRow, SettingsSection } from '@getpaseo/plugin/client/ui';
import type { RpcOutput } from '@getpaseo/plugin';
import { storageState } from '../shared/settings.ts';

const MIB = 1024 * 1024;
type Usage = NonNullable<RpcOutput<typeof storageState>>;

export function StorageSettings({ limit, saving, save }: { limit: number; saving: boolean; save: (limit: number) => void }) {
  const read = useRpc(storageState);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [value, setValue] = useState(String(limit / MIB));
  const [preview, setPreview] = useState<Usage['preview']>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const bytes = Math.round(Number(value) * MIB);
  useEffect(() => {
    let active = true;
    const poll = () => read({}).then(result => { if (active) setUsage(result); })
      .catch(() => { if (active) setError('无法读取存储用量'); });
    void poll();
    const timer = setInterval(poll, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [read]);

  async function update() {
    if (preview || bytes >= limit) { save(bytes); setPreview(undefined); return; }
    setLoading(true);
    try {
      const state = await read({ previewLimit: bytes });
      if (!state?.preview) { setError('中心尚未就绪，请重试'); return; }
      if (state.preview.used > bytes) setPreview(state.preview);
      else save(bytes);
    } catch { setError('无法预估清除量，请重试'); }
    finally { setLoading(false); }
  }

  return <SettingsSection title="工具详情存储">
    <SettingsRow label={usage ? `已用 ${(usage.used / MIB).toFixed(2)} MiB，上限 ${limit / MIB} MiB` : '等待读取用量'}
      hint={usage ? `最早保留：${usage.oldest ?? '无'}${usage.blocked ? '；仍超限，请调高上限' : ''}` : undefined} error={error || undefined} />
    <SettingsInput label="存储上限（MiB）" initialValue={value} disabled={loading || saving}
      onChangeText={text => { setValue(text); setPreview(undefined); setError(''); }} />
    {preview && <SettingsRow label={`预计清除 ${preview.clearBytes} 字节，清除后最早保留：${preview.oldest ?? '无'}`} />}
    <SettingsAction label="修改工具详情上限" actionLabel={preview ? '确认清除并保存' : '应用上限'}
      disabled={!usage || saving || loading || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes === limit} onPress={() => void update()} />
    {preview && <SettingsAction label="保留当前上限" actionLabel="取消" onPress={() => setPreview(undefined)} />}
  </SettingsSection>;
}
