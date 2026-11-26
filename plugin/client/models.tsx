import { useEffect, useRef, useState } from 'react';
import type { RpcInput, RpcOutput } from '@getpaseo/plugin';
import { useRpc } from '@getpaseo/plugin/client';
import { SettingsAction, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, type SettingsInputHandle } from '@getpaseo/plugin/client/ui';

import { localTime } from '../../src/shared/board-time.ts';
import { CREDENTIAL_MODES } from '../../src/shared/model-settings.ts';
import { modelSettings } from '../shared/models.ts';

type View = RpcOutput<typeof modelSettings>;
type Save = (change: NonNullable<RpcInput<typeof modelSettings>['change']>) => Promise<boolean>;

function ModelChoice({ label, model, hint, options, saving, save }: {
  label: string; model: string; hint: string; options: View['model_options']; saving: boolean; save(model: string): Promise<boolean>;
}) {
  const [custom, setCustom] = useState(!options.some(option => option.id === model));
  const [draft, setDraft] = useState(model);
  return <>
    <SettingsSelect label={label}
      hint={hint}
      value={custom ? '' : model} disabled={saving}
      options={[...options.map(option => ({ value: option.id, label: option.label })), { value: '', label: '其他模型 ID' }]}
      onValueChange={choice => {
        if (!choice || choice === model) {
          setDraft(model);
          setCustom(!choice);
        }
        else void save(choice);
      }} />
    {custom && <>
      <SettingsInput label={label + '模型 ID'} initialValue={model} onChangeText={setDraft} disabled={saving} />
      <SettingsAction label={label + '自定义模型'} actionLabel="保存模型" disabled={saving || !draft.trim() || draft.trim() === model}
        onPress={() => void save(draft.trim())} />
    </>}
  </>;
}

const accountNames = { login: '本机登录', oauth_token: 'OAuth token', api_key: 'API key' };
const origins = { settings: '设置页选择', config: '配置文件的 OAuth token 文件', default: '默认' };
function Account({ provider, saving, save }: { provider: View['provider']; saving: boolean; save: Save }) {
  const [mode, setMode] = useState(provider.mode);
  const input = useRef<SettingsInputHandle>(null);
  const [entered, setEntered] = useState(false);
  const suffix = mode === 'login' ? undefined : provider.stored[mode];
  async function apply() {
    const secret = mode === 'login' ? undefined : input.current?.getText().trim() || undefined;
    if (await save({ kind: 'provider', mode, secret })) {
      input.current?.replaceText('');
      setEntered(false);
    }
  }
  return <>
    <SettingsSelect<View['provider']['mode']> label="模型账号" hint={`当前生效：${accountNames[provider.mode]}（${origins[provider.origin]}）`}
      value={mode} disabled={saving} onValueChange={value => { setMode(value); setEntered(false); }}
      options={CREDENTIAL_MODES.map(value => ({ value, label: accountNames[value] }))} />
    {mode !== 'login' && <SettingsInput ref={input} key={mode} label={accountNames[mode]} secureTextEntry disabled={saving} onChangeText={text => setEntered(Boolean(text.trim()))}
      hint={suffix ? `已保存，末四位 ${suffix}；留空沿用` : '请填入要使用的凭据'} />}
    <SettingsAction label="账号设置" actionLabel="保存账号" disabled={saving || (mode !== 'login' && !suffix && !entered)} onPress={() => void apply()} />
  </>;
}

export function ModelSettings() {
  const rpc = useRpc(modelSettings);
  const [state, setState] = useState<View>();
  const [saving, setSaving] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (saving) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const current = await rpc({});
        if (active) {
          setState(current);
          setReadFailed(false);
        }
      } catch {
        if (active) setReadFailed(true);
      } finally {
        if (active) timer = setTimeout(refresh, 30_000);
      }
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [rpc, saving]);

  const save: Save = async change => {
    setSaving(true);
    setError('');
    try {
      setState(await rpc({ change }));
      return true;
    } catch {
      setError(change.kind !== 'provider' ? '模型未保存，请检查模型 ID 后重试' : '账号未保存，请检查凭据后重试');
      return false;
    } finally {
      setSaving(false);
    }
  };
  return <SettingsSection title="模型">
    {readFailed && <SettingsRow label="无法读取模型设置，请检查中心状态" />}
    {!state && !readFailed && <SettingsRow label="读取模型设置中" />}
    {state && <>
      <SettingsRow label={!state.enabled ? '理解层已关闭' : state.paused_until ? '理解层已暂停' : '理解层未暂停'}
        hint={state.paused_until ? state.pause_reason ?? `恢复时间：${localTime(state.paused_until)}` : undefined} />
      {state.roles.map(row => <ModelChoice key={row.role + ':' + row.model} label={row.label} model={row.model}
        hint={`当前：${row.model} · 最近 7 天调用 ${row.calls} 次，失败 ${row.failures} 次`}
        options={state.model_options} saving={saving} save={model => save({ kind: 'model', role: row.role, model })} />)}
      <ModelChoice key={'steward:' + state.steward.model} label="总管" model={state.steward.model} options={state.model_options} saving={saving}
        hint={'Claude · ' + state.steward.model + '。Codex 的只读沙箱仍能执行命令，当前 Paseo 无法为单个 Codex agent 关闭命令工具。'}
        save={model => save({ kind: 'steward', provider: 'claude', model })} />
      <Account key={state.provider.mode + ':' + state.provider.origin} provider={state.provider} saving={saving} save={save} />
    </>}
    {error && <SettingsRow label={error} />}
  </SettingsSection>;
}
