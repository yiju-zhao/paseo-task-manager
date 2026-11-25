import { beforeEach, expect, test, vi } from 'vitest';
import { contentHash } from '../../src/server/ingest-repo.ts';
import type { EventPointer } from '../../src/context/upstream.ts';
import { normalizeEntry } from '../server/collector/normalize.ts';
import { upstreamReader } from '../server/upstream.ts';
import { FakePaseo } from './helpers/fake-paseo.ts';

let sdk: FakePaseo;
let pointer: EventPointer;
const output = 'result'.repeat(5000);
beforeEach(async () => {
  sdk = new FakePaseo();
  await sdk.connect();
  sdk.addAgent('fixture');
  const row = sdk.tool('fixture', { command: 'test', output }, 'one');
  const normalized = normalizeEntry(row, 'epoch', new Date());
  if (!('event' in normalized)) throw new Error('expected a tool event');
  pointer = { server_id: sdk.serverId(), agent_id: 'fixture', event_key: 'tool:one',
    hash: contentHash(normalized.event), ts: normalized.event.ts };
});

test('Retrieving a loaded tool by stable ID returns the full upstream output.', async () => {
  const read = upstreamReader(async () => sdk, () => true, () => false);
  expect(await read(pointer, new AbortController().signal)).toEqual({ text: '【输入】\ntest\n\n【输出】\n' + output });
});

test('Disabling collection prevents even opening a transport for explicit detail reads.', async () => {
  const open = vi.fn(async () => sdk);
  const read = upstreamReader(open, () => false, () => true);
  expect(await read(pointer, new AbortController().signal)).toEqual({ reason: '这台机器的采集已关闭，在设置里打开后可读取' });
  expect(open).not.toHaveBeenCalled();
});

test('A closed agent is never sent a timeline request with history reads disabled.', async () => {
  sdk.setStatus('fixture', 'closed');
  const read = upstreamReader(async () => sdk, () => true, () => false);
  expect(await read(pointer, new AbortController().signal)).toEqual({ reason: expect.stringContaining('重新加载') });
  expect(sdk.timelineReads).toEqual([]);
});

test('Enabling closed history allows an explicit timeline read for an archived agent.', async () => {
  sdk.archive('fixture');
  const read = upstreamReader(async () => sdk, () => true, () => true);
  expect(await read(pointer, new AbortController().signal)).toHaveProperty('text');
  expect(sdk.timelineReads).toEqual(['fixture']);
});
