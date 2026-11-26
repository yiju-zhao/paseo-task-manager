import type { DatabaseSync } from 'node:sqlite';
import { readItem, readTurn, textPage } from './read.ts';

export type EventPointer = { server_id: string; agent_id: string; event_key: string; ts: string | null; hash: string };
export type Upstream = (pointer: EventPointer, signal: AbortSignal) => Promise<{ text: string } | { reason: string }>;
const READ_TIMEOUT_MS = 15_000;

export async function explicitItem(db: DatabaseSync, session: string, turn: number, item: number, offset: number, upstream?: Upstream,
  signal = AbortSignal.timeout(READ_TIMEOUT_MS)) {
  const raw = readItem(db, session, turn, item, { offset });
  if (!upstream || !raw.cleared) return raw;
  const expired = Promise.withResolvers<never>();
  const abort = () => expired.reject(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  let reason: string;
  try {
    signal.throwIfAborted();
    const result = await Promise.race([upstream({ ...raw.pointer, ...raw.cleared }, signal), expired.promise]);
    if ('text' in result) return { ...raw, ...textPage(result.text, offset), missing: false, truncated: null };
    reason = result.reason;
  } catch {
    reason = signal.aborted ? '回源读取超时' : '无法读取上游时间线';
  } finally {
    signal.removeEventListener('abort', abort);
  }
  return { ...raw, text: [raw.text, reason, `在 Paseo 的主机 ${raw.pointer.server_id} 中打开 agent ${raw.pointer.agent_id}`].join('\n') };
}

export async function explicitTurn(db: DatabaseSync, session: string, n: number, turn: ReturnType<typeof readTurn>, upstream?: Upstream) {
  if (!upstream) return turn;
  const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
  for (const [index, item] of turn.items.entries()) {
    if (!item.cleared) continue;
    const raw = await explicitItem(db, session, n, index + 1, 0, upstream, signal);
    item.detail = raw.text + (raw.next_offset === null ? '' : `\n更多原文：pm_read_raw ${item.address} offset=${raw.next_offset}`);
  }
  return turn;
}
