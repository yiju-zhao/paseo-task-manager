import type { PaseoApi } from '@getpaseo/client';
import { agentReads, TimelineUnavailable, isLoaded } from './collector/sdk.ts';
import type { ConnectionStatus, PaseoSdk } from './collector/sdk.ts';

/** Expose data, owned observations and cleanup only. The full SDK handle never reaches the collector or its callers. */
export type HostScope = Pick<PaseoApi, 'agents' | 'dispose'>;

export function routedReader(api: HostScope, serverId: string, connection: () => ConnectionStatus, selected: () => boolean, readClosed: () => boolean): PaseoSdk {
  const reads = agentReads(api.agents);
  async function checkContent(id: string, subscribe = false) {
    if (!selected()) throw new TimelineUnavailable('source deselected');
    const agent = await reads.fetchAgent(id);
    if (!selected() || !agent || (subscribe && !!agent.archivedAt) || (!readClosed() && (agent.archivedAt || !isLoaded(agent)))) {
      throw new TimelineUnavailable('timeline unavailable under current collection settings');
    }
  }
  return Object.freeze({
    ...reads,
    connect: async () => { if (connection() !== 'connected') throw new Error('host offline'); },
    close: () => api.dispose(),
    serverId: () => serverId,
    connectionStatus: connection,
    fetchTimeline: async (id, options) => { await checkContent(id); return reads.fetchTimeline(id, options); },
    subscribeTimeline: async (id, handler) => { await checkContent(id, true); return reads.subscribeTimeline(id, handler); },
  } satisfies PaseoSdk);
}
