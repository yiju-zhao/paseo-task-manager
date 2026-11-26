import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPaseoClient, type PaseoAgentCreateOptions } from '@getpaseo/client';
import type { PluginSessionOpenRequest } from '@getpaseo/plugin/server';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';

import { readTools } from '../../src/mcp/read-tools.ts';
import { agent, config, event, PaseoWriter, startCenter, type Center } from '../../tests/helpers/center.ts';
import { createSteward, openSteward } from '../server/steward.ts';

let center: Center;
let dir: string;
const request: PluginSessionOpenRequest = { agentId: 'fixture-agent', workspaceId: null, provider: 'claude', cwd: '/work',
  reason: 'create', purpose: 'interactive', title: '总管', labels: { 'task-manager/role': 'steward' }, metadata: {}, background: false,
  tools: [], mcpServers: {}, env: {}, appendSystemPrompt: ['existing'] };
const create = vi.fn(async (_options: PaseoAgentCreateOptions) => ({ id: 'new-agent' }));
const deps = { now: () => center.now, newId: (prefix: string) => prefix + '_test' };
const board = () => ({ db: center.db, deps, sources: { config, startedAt: center.now } });
beforeEach(() => { center = startCenter(); dir = mkdtempSync(join(tmpdir(), 'steward-')); create.mockClear(); });
afterEach(() => { center.close(); rmSync(dir, { recursive: true, force: true }); });

test('Creating a Claude steward sends its restrictions and initial question in the original creation request.', async () => {
  const created = await createSteward(create, dir, 'fixture-host', { provider: 'claude', model: 'claude-opus-5-5' }, {});
  expect(created).toEqual({ agentId: 'new-agent', serverId: 'fixture-host' });
  const args = create.mock.calls[0][0];
  expect(args).toMatchObject({ cwd: join(dir, 'steward'), title: '总管', labels: request.labels, prompt: '看一下现在的全局态势，告诉我最需要注意的事',
    config: { provider: 'claude/claude-opus-5-5', options: { disallowedTools: expect.arrayContaining(['Bash', 'Write', 'Edit', 'NotebookEdit']) } } });
  expect(statSync(args.cwd).mode & 0o777).toBe(0o700);
});
test('The project question is part of the first message.', async () => {
  await createSteward(create, dir, 'fixture-host', { provider: 'claude', model: 'fixture-model' }, { question: '目前有哪些阻塞？', projectId: 'p_fixture', requestKey: 'submitted-once' });
  expect(create.mock.calls[0][0]).toMatchObject({ prompt: '目前有哪些阻塞？\n\n项目 ID：p_fixture', idempotencyKey: 'submitted-once' });
});
test('The main Claude agent has an exact allowlist for files, coordination and the two board tool namespaces.', async () => {
  await createSteward(create, dir, 'fixture-host', { provider: 'claude', model: 'fixture-model' }, {});
  const args = create.mock.calls[0][0].config.options?.extraArgs;
  const flags = z.object({ agent: z.string(), agents: z.string() }).parse(args);
  const profiles = z.record(z.string(), z.object({ tools: z.array(z.string()) })).parse(JSON.parse(flags.agents));
  const boardTools = ['pm_overview', 'pm_get_brief', 'pm_get_project', 'pm_timeline', 'pm_search', 'pm_list_sessions', 'pm_get_session',
    'pm_get_turn', 'pm_read_raw', 'pm_report'];
  expect(profiles[flags.agent].tools.sort()).toEqual(['Read', 'Glob', 'Grep',
    ...['list_hosts', 'list_workspaces', 'list_agents', 'get_agent_status', 'get_agent_activity', 'send_agent_prompt', 'create_agent'].map(name => 'mcp__paseo__' + name),
    ...['paseo', 'agent-pm'].flatMap(server => boardTools.map(name => 'mcp__' + server + '__' + name))].sort());
});
test('An ordinary agent gets no tools or instructions even when it is named 总管.', async () => {
  const ready = vi.fn(board);
  expect(await openSteward({ ...request, labels: {} }, ready)).toBeUndefined();
  expect(ready).not.toHaveBeenCalled();
});
test('Only the first opening consumes the steward cursor and appends a dated snapshot.', async () => {
  const first = await openSteward(request, board);
  expect(first?.appendSystemPrompt?.[0]).toBe('existing');
  expect(first?.appendSystemPrompt?.join('\n')).toContain('以下是 ' + center.now.toISOString() + ' 的全局态势快照');
  expect(first?.appendSystemPrompt?.join('\n')).toContain('回答用户的每个新问题前，先调用 pm_overview 获取最新态势');
  const before = center.db.prepare("SELECT * FROM reader_cursors WHERE reader='steward'").get();
  center.advance(60_000);
  const next = await openSteward({ ...request, reason: 'resume' }, board);
  expect(next?.appendSystemPrompt?.join('\n')).not.toContain('的全局态势快照');
  expect(center.db.prepare("SELECT * FROM reader_cursors WHERE reader='steward'").get()).toEqual(before);
});
test.each(['create', 'resume', 'refresh'] as const)('A %s opening attaches exactly the ten board tools.', async reason => {
  const launch = await openSteward({ ...request, reason }, board);
  expect(launch?.env).toMatchObject({ ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1' });
  expect(launch?.tools.map(t => t.name).sort()).toEqual(['pm_overview','pm_get_brief','pm_get_project','pm_timeline','pm_search',
    'pm_list_sessions','pm_get_session','pm_get_turn','pm_read_raw','pm_report'].sort());
});
test.each(['create', 'resume', 'refresh'] as const)('The %s turn tool returns the same explicit evidence as external MCP.', async reason => {
  const writer = new PaseoWriter(center); await writer.lease();
  await writer.snapshot([agent('a', { native_id: 'abcd1234', native_id_origin: 'runtime' })]);
  await writer.batch(writer.batchBody('a', null, { epoch: 'epoch-1', seq: 2 }, [
    event('prompt', 1, { kind: 'user', text: 'fixture evidence' }),
    event('tool', 2, { kind: 'tool', text: '', tool: { name: 'read', status: 'completed', exit_code: 0,
      input: '', output: 'retained detail', error: null, input_truncated: null, output_truncated: null } }),
  ]));
  center.db.exec("UPDATE source_events SET meta=json_set(meta, '$.detail_cleared_at', 'fixture', '$.tool.output', '') WHERE kind='tool'");
  const sources = { ...board().sources, upstream: async () => ({ text: 'explicit upstream evidence' }) };
  const launch = await openSteward({ ...request, reason }, () => ({ ...board(), sources }));
  const args = { turn: 's:abcd1234#1' };
  const direct = readTools(center.db, deps, 'mcp-test', sources).find(t => t.name === 'pm_get_turn')!;
  const api = createPaseoClient({ url: 'ws://fixture.invalid' });
  try {
    const expected = await direct.handler(args);
    expect(expected.text).toContain('explicit upstream evidence');
    expect(await launch!.tools.find(t => t.name === direct.name)!.execute(args, { paseo: api, signal: new AbortController().signal,
      agent: { id: request.agentId, workspaceId: null, parentAgentId: null, provider: 'claude', cwd: request.cwd, title: '总管', background: false, metadata: {} } }))
      .toEqual(expected);
  } finally { await api.close(); }
});

async function runPreToolHook(tool: string, input: object) {
  await createSteward(create, dir, 'fixture-host', { provider: 'claude', model: 'fixture-model' }, {});
  const flags = z.object({ settings: z.string() }).parse(create.mock.calls[0][0].config.options?.extraArgs);
  const settings = z.object({ hooks: z.object({ PreToolUse: z.array(z.object({ matcher: z.string(), hooks: z.array(z.object({
    command: z.string(), args: z.array(z.string()), onFailure: z.literal('block'),
  })) })) }) }).parse(JSON.parse(flags.settings));
  const matches = settings.hooks.PreToolUse.filter(rule => new RegExp(rule.matcher).test(tool));
  expect(matches).toHaveLength(1);
  const [hook] = matches[0].hooks;
  return spawnSync(hook.command, hook.args, { input: JSON.stringify({ tool_name: tool, tool_input: input }), encoding: 'utf8' });
}

test.each([
  [{ sessionMode: 'full-access' }, 2],
  [{ activeTurnBehavior: 'interrupt' }, 2],
  [{ activeTurnBehavior: 'steer' }, 2],
  [{ activeTurnBehavior: 'queue' }, 0],
  [{}, 0],
])('The per-agent pre-tool rule checks the delivery parameters %j.', async (parameters, status) => {
  const run = await runPreToolHook('mcp__paseo__send_agent_prompt', { agentId: 'test-agent', prompt: 'fixture', ...parameters });
  expect(run.status).toBe(status);
  if (status === 2) expect(run.stderr).toContain('排队');
});

test.each([
  [{ settings: { modeId: 'default' } }, 2],
  [{ settings: { modeId: null } }, 2],
  [{ settings: { features: { fast_mode: false } } }, 2],
  [{ settings: { features: {} } }, 0],
  [{}, 0],
])('The creation hook checks nested mode and feature overrides %j.', async (parameters, status) => {
  const run = await runPreToolHook('mcp__paseo__create_agent', { provider: 'claude/model', title: 'fixture', initialPrompt: 'Continue',
    labels: {}, workspaceId: 'workspace', serverId: 'fixture-host', background: false, notifyOnFinish: false, ...parameters });
  expect(run.status).toBe(status);
  if (status === 2) expect(run.stderr).toContain('默认模式');
});
test('Default mode preapproves reads and asks for both coordination actions.', async () => {
  await createSteward(create, dir, 'fixture-host', { provider: 'claude', model: 'fixture-model' }, {});
  const config = create.mock.calls[0][0].config;
  expect(config.modeId).toBe('default');
  const options = z.object({ allowedTools: z.array(z.string()), extraArgs: z.object({ agent: z.string(), agents: z.string(), settings: z.string() }) }).parse(config.options);
  const profiles = z.record(z.string(), z.object({ tools: z.array(z.string()) })).parse(JSON.parse(options.extraArgs.agents));
  const { permissions } = z.object({ permissions: z.object({ ask: z.array(z.string()) }) }).parse(JSON.parse(options.extraArgs.settings));
  expect(permissions.ask.sort()).toEqual(['mcp__paseo__create_agent', 'mcp__paseo__send_agent_prompt']);
  expect(options.allowedTools.sort()).toEqual(profiles[options.extraArgs.agent].tools.filter(name => !permissions.ask.includes(name)).sort());
});
