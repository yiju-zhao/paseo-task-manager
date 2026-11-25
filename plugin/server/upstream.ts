import type { EventPointer, Upstream } from '../../src/context/upstream.ts';
import { formatToolText } from '../../src/context/read.ts';
import { contentHash } from '../../src/server/ingest-repo.ts';
import { errorText, normalizeEntry, toolText } from './collector/normalize.ts';
import { isLoaded, type PaseoSdk, type TimelineCursor } from './collector/sdk.ts';

type Reader = Pick<PaseoSdk, 'fetchAgent' | 'fetchTimeline' | 'close'>;
export function upstreamReader(open: (id: string) => Promise<Reader>, selected: (id: string) => boolean, readClosed: () => boolean): Upstream {
  return async (pointer: EventPointer, signal) => {
    const disabled = '这台机器的采集已关闭，在设置里打开后可读取';
    if (!selected(pointer.server_id)) return { reason: disabled };
    let sdk: Reader;
    try { sdk = await open(pointer.server_id); } catch { return { reason: '机器离线或未连接' }; }
    try {
      let cursor: TimelineCursor | undefined;
      do {
        signal.throwIfAborted();
        if (!selected(pointer.server_id)) return { reason: disabled };
        const agent = await sdk.fetchAgent(pointer.agent_id);
        if (!agent) return { reason: '找不到这个 agent，可能已删除' };
        if (!readClosed() && (agent.archivedAt || !isLoaded(agent))) return { reason: '中心已清除这段详情；读取需要重新加载这个 agent' };
        signal.throwIfAborted();
        if (!selected(pointer.server_id)) return { reason: disabled };
        const page = await sdk.fetchTimeline(pointer.agent_id, { direction: cursor ? 'before' : 'tail', cursor, limit: 100 });
        if (page.error) return { reason: '会话历史不可用，可能已清理' };
        for (const entry of page.entries) {
          if (entry.item.type !== 'tool_call') continue;
          const result = normalizeEntry(entry, page.epoch, new Date());
          if (!('event' in result) || result.event.key !== pointer.event_key || contentHash({ ...result.event, ts: pointer.ts }) !== pointer.hash) continue;
          const detail = entry.item.detail;
          if (!detail || typeof detail !== 'object' || Array.isArray(detail)) continue;
          const fields = toolText(detail as Record<string, unknown>);
          return { text: formatToolText({ ...fields, error: errorText(entry.item.error) }) };
        }
        if (!page.hasOlder || !page.startCursor || (cursor && page.startCursor.epoch === cursor.epoch && page.startCursor.seq >= cursor.seq)) break;
        cursor = page.startCursor;
      } while (true);
      return { reason: '时间线里找不到这条记录的相同版本' };
    } finally {
      await sdk.close();
    }
  };
}
