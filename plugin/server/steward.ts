import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import type { PaseoAgentCreateOptions } from '@getpaseo/client';
import { defineAgentTool, type PluginSessionOpenRequest } from '@getpaseo/plugin/server';
import { z } from 'zod';

import type { DomainDeps } from '../../src/domain/types.ts';
import type { OverviewSources } from '../../src/mcp/context-tools.ts';
import { readTools } from '../../src/mcp/read-tools.ts';
import type { StewardModel } from '../../src/shared/model-settings.ts';

const role = '你是用户所有项目的总管，负责回答进展问题，并在用户要求时协调其他 agent。开始时附上的"全局态势"是当时的快照。快照可能已过时，回答用户的每个新问题前，先调用 pm_overview 获取最新态势，再按地址下钻核实，结论后面写上依据的地址。需要让其他 agent 做事时，用 Paseo 的工具（列出 agent、给 agent 发消息、创建 agent），发之前先告诉用户你打算发什么。你不能执行命令，也不能改文件。需要记入看板的结论用 pm_report 上报。';
const label = 'task-manager/role';
const boardTools = new Set(['pm_overview', 'pm_get_brief', 'pm_get_project', 'pm_timeline', 'pm_search', 'pm_list_sessions',
  'pm_get_session', 'pm_get_turn', 'pm_read_raw', 'pm_report']);

export async function createSteward(create: (options: PaseoAgentCreateOptions) => Promise<{ id: string }>, stateRoot: string,
  serverId: string, model: StewardModel, input: { question?: string; projectId?: string; requestKey?: string }): Promise<{ serverId: string; agentId: string }> {
  const cwd = join(stateRoot, 'steward');
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const question = input.question?.trim() || '看一下现在的全局态势，告诉我最需要注意的事';
  const coordination = ['list_hosts', 'list_workspaces', 'list_agents', 'get_agent_status', 'get_agent_activity', 'send_agent_prompt', 'create_agent'];
  // Claude's main-agent profile restricts MCP tools as well as built-ins. allowedTools alone only preapproves calls.
  const tools = ['Read', 'Glob', 'Grep', ...coordination.map(name => 'mcp__paseo__' + name),
    ...['paseo', 'agent-pm'].flatMap(server => [...boardTools].map(name => 'mcp__' + server + '__' + name))];
  const profile = 'task-manager-steward';
  // Exec-form hook: the message is JSON on stdin, never part of a shell command.
  const checkDelivery = `
    const { tool_input: message } = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
    if (Object.hasOwn(message, 'sessionMode') || (Object.hasOwn(message, 'activeTurnBehavior') && message.activeTurnBehavior !== 'queue')) {
      process.stderr.write('总管只能排队发消息，不能设置 sessionMode，也不能打断或插入对方的回合。');
      process.exitCode = 2;
    }
  `;
  const hooks = { PreToolUse: [{ matcher: '^mcp__paseo__send_agent_prompt$', hooks: [
    { type: 'command', command: process.execPath, args: ['-e', checkDelivery], onFailure: 'block' },
  ] }] };
  const agent = await create({ cwd, idempotencyKey: input.requestKey, title: '总管', labels: { [label]: 'steward' },
    config: { provider: model.provider + '/' + model.model, options: {
      disallowedTools: ['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task', 'REPL'],
      extraArgs: { agent: profile, settings: JSON.stringify({ disableAllHooks: false, hooks }), agents: JSON.stringify({ [profile]: { description: '项目总管', prompt: '', tools } }) },
    } },
    prompt: input.projectId ? question + '\n\n项目 ID：' + input.projectId : question });
  return { serverId, agentId: agent.id };
}

type BoardContext = { db: DatabaseSync; deps: DomainDeps; sources: OverviewSources };
export async function openSteward(request: PluginSessionOpenRequest, ready: () => BoardContext | Promise<BoardContext>): Promise<PluginSessionOpenRequest | undefined> {
  if (request.provider !== 'claude' || request.labels[label] !== 'steward' || request.purpose !== 'interactive') return;
  const { db, deps, sources } = await ready();
  const definitions = readTools(db, deps, 'steward', sources).filter(t => boardTools.has(t.name));
  const instructions = [...(request.appendSystemPrompt ?? []), role];
  if (request.reason === 'create') {
    const at = deps.now().toISOString();
    const overview = await definitions.find(t => t.name === 'pm_overview')!.handler({});
    instructions.push('以下是 ' + at + ' 的全局态势快照\n' + overview.text);
  }
  return { ...request, env: { ...request.env, ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1' },
    appendSystemPrompt: instructions,
    tools: [...request.tools, ...definitions.map(t => defineAgentTool({ name: t.name, description: t.description,
      input: z.strictObject(t.input), execute: args => t.handler(args) }))] };
}
