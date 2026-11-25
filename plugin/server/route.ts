import { randomUUID } from 'node:crypto';
import type { PaseoApi, PaseoClient } from '@getpaseo/client';
import { routedReader } from './transport.ts';

type FileCountReader = (cwd: string) => Promise<number | null>;

/** Conversation, directory and workspace reads use only the public, independently owned scope. */
export async function openSource(origin: PaseoClient, serverId: string, selected: () => boolean, readClosed: () => boolean, count: FileCountReader) {
  const api = await origin.hosts.client(serverId);
  return {
    sdk: routedReader(api, serverId, () => origin.getConnectionState().status, selected, readClosed),
    repository: repositoryReads(api.workspaces, count),
  };
}

type Checkout = { getCheckoutDiff(cwd: string, compare: { mode: 'uncommitted' }): Promise<{
  files: unknown[]; error?: unknown; diffTooLarge?: boolean;
}> };

/** Keep paths and hunks inside this optional transport. An incomplete inventory has no exact count. */
export function checkoutReader(client: Checkout): FileCountReader {
  return async cwd => {
    try {
      const diff = await client.getCheckoutDiff(cwd, { mode: 'uncommitted' });
      if (diff.error || diff.diffTooLarge || !Array.isArray(diff.files)) return null;
      return diff.files.length;
    } catch { return null; }
  };
}

async function loadCheckoutDriver() {
  const [{ DaemonClient }, { createHostChannelTransport }] = await Promise.all([
    import('@getpaseo/client/internal/daemon-client'),
    import('@getpaseo/client/internal/hosts'),
  ]);
  return { DaemonClient, createHostChannelTransport };
}

/** Allocate a separate one-hop channel only for an actual diff. Never hand this channel to the collector. */
export function optionalFileCounter(url: string, managingId: string, serverId: string, load = loadCheckoutDriver): FileCountReader {
  return async cwd => {
    try {
      const { DaemonClient, createHostChannelTransport } = await load();
      const origin = new DaemonClient({ url, clientType: 'cli', clientId: randomUUID(), reconnect: { enabled: false } });
      try {
        await origin.connect();
        if (origin.getLastServerInfoMessage()?.serverId !== managingId) return null;
        const id = randomUUID();
        const remote = new DaemonClient({
          url: 'ws://routed-host/ws', clientId: id, reconnect: { enabled: false },
          transportFactory: createHostChannelTransport(origin, serverId, id, null),
        });
        try {
          await remote.connect();
          if (remote.getLastServerInfoMessage()?.serverId !== serverId) return null;
          return await checkoutReader(remote)(cwd);
        } finally { await remote.close(); }
      } finally { await origin.close(); }
    } catch { return null; }
  };
}

export function repositoryReads(workspaces: Pick<PaseoApi['workspaces'], 'ref'>, changedFileCount: FileCountReader) {
  return Object.freeze({ workspace: (id: string) => workspaces.ref(id).refresh(), changedFileCount });
}
