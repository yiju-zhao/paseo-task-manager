import { afterEach, beforeEach, expect, test } from 'vitest';

import type { TimelineEvent } from '../../src/shared/ingest-v2.ts';
import { agent, count, event, PaseoWriter, startCenter } from '../helpers/center.ts';
import type { Center } from '../helpers/center.ts';

const AGENT_ID = 'agent-1';
const FIRST_EPOCH = 'epoch-1';
const NEXT_EPOCH = 'epoch-2';
// A reloaded agent re-reads its history; the daemon stamps the replayed rows with new times.
const REPLAY_DELAY_MS = 3_600_000;

let center: Center;
let writer: PaseoWriter;

beforeEach(async () => {
  center = startCenter();
  writer = new PaseoWriter(center);
  await writer.lease();
  await writer.snapshot([agent(AGENT_ID)]);
});

afterEach(() => center.close());

const storedEvents = () => count(center.db, 'SELECT count(*) AS n FROM source_events');
const storedChunks = () => count(center.db, 'SELECT count(*) AS n FROM chunks');

function originalHistory(): TimelineEvent[] {
  return [
    event('msg:ask', 1, { kind: 'user', item_type: 'user_message', text: 'run the tests' }),
    event('tool:run', 2, {
      kind: 'tool',
      item_type: 'tool_call',
      text: '',
      tool: { name: 'shell', status: 'completed', exit_code: 0, input: 'npm test', input_truncated: null, output: 'ok', output_truncated: null, error: null },
    }),
    event('msg:answer', 3, { text: 'all tests pass' }),
  ];
}

function replayed(history: TimelineEvent[]): TimelineEvent[] {
  return history.map((e) => ({ ...e, epoch: NEXT_EPOCH, ts: new Date(Date.parse(e.ts!) + REPLAY_DELAY_MS).toISOString() }));
}

async function deliverOriginal(): Promise<void> {
  const history = originalHistory();
  const sent = await writer.batch(writer.batchBody(AGENT_ID, null, { epoch: FIRST_EPOCH, seq: history.length }, history));
  expect(sent.status).toBe(200);
}

async function deliverReplay(events: TimelineEvent[]): Promise<void> {
  const sent = await writer.batch(
    writer.batchBody(AGENT_ID, { epoch: FIRST_EPOCH, seq: 3 }, { epoch: NEXT_EPOCH, seq: events.length }, events, {
      reset: { previous_epoch: FIRST_EPOCH, reason: 'replacement' },
    }),
  );
  expect(sent.status).toBe(200);
}

test('history replayed in a new epoch with only new timestamps stores no new events', async () => {
  await deliverOriginal();
  const before = storedEvents();
  await deliverReplay(replayed(originalHistory()));
  expect(storedEvents()).toBe(before);
});

test('history replayed in a new epoch with only new timestamps produces no new chunks', async () => {
  await deliverOriginal();
  const before = storedChunks();
  await deliverReplay(replayed(originalHistory()));
  expect(storedChunks()).toBe(before);
});

test('a replayed event keeps the timestamp it was first stored with', async () => {
  await deliverOriginal();
  await deliverReplay(replayed(originalHistory()));
  const stamps = center.db.prepare("SELECT DISTINCT ts FROM source_events WHERE event_key = 'msg:answer'").all();
  expect(stamps).toEqual([{ ts: originalHistory()[2]!.ts }]);
});

test('an event replayed with other text is still stored as a new version', async () => {
  await deliverOriginal();
  const before = storedEvents();
  const history = replayed(originalHistory());
  history[2] = { ...history[2]!, text: 'all tests pass except one' };
  await deliverReplay(history);
  expect(storedEvents()).toBe(before + 1);
});
