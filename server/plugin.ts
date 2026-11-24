import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPaseoClient } from '@getpaseo/client';
import { openSource, optionalFileCounter } from './route.ts';
import { HistoryImport } from './collector/history-import.ts';
import type { PluginServerContext } from '@getpaseo/plugin/server';
import { createCenterClient } from './collector/client.ts';
import { PaseoCollectorConfig } from './collector/config.ts';
import { PaseoCollector } from './collector/loop.ts';
import { Outbox } from './collector/outbox.ts';
import { isLoaded } from './collector/sdk.ts';
import { StateDir } from './collector/state-store.ts';
import { readConfig, type Source } from './config.ts';
import { importProgress, settings, type Preferences } from '../shared/settings.ts';
import { RemoteWorkspaces, type UnknownFileCount } from './workspaces.ts';

export default function contribute(server: PluginServerContext) {
  const stored = server.registerSettings(settings);
  const cfg = readConfig();
  const local = createPaseoClient({ url: cfg.daemonUrl, clientId: 'paseo-task-manager-' + randomUUID(), connectTimeoutMs: 5000 });
  const writers = new Map(cfg.sources.map(s => [s.serverId, 'paseo-' + randomUUID()]));
  const workers = new Map<string, PaseoCollector>();
  const ledgers = new Map<string, HistoryImport>();
  const unknownFiles = new Map<string, Map<string, UnknownFileCount>>();
  const missing = new Set<string>();
  let prefs: Preferences = { selectedHosts: [], readClosed: false };
  let stopped = false;
  let pending = false;
  let current: Promise<void> | undefined;
  const selected = (id: string) => !stopped && prefs.selectedHosts.includes(id);
  const log = (s: string) => console.info(s);

  async function start(source: Source) {
    const { serverId, sourceId } = source;
    const token = readFileSync(source.tokenFile, 'utf8').trim();
    if (!token) throw new Error('empty tokenFile for ' + sourceId);
    const count = optionalFileCounter(cfg.daemonUrl, cfg.daemonServerId, serverId);
    const { sdk, repository } = await openSource(local, serverId, () => selected(serverId), () => prefs.readClosed, count);
    let state: StateDir | undefined;
    let worker: PaseoCollector | undefined;
    try {
      const config = PaseoCollectorConfig.parse({
        ...source, server: cfg.centerUrl, paseo: { url: cfg.daemonUrl, serverId },
        stateDir: join(cfg.stateRoot, sourceId), readArchivedTracked: true, includeArchivedHistory: true,
      });
      state = StateDir.open(config.stateDir, { sourceId, serverId, server: cfg.centerUrl }, writers.get(serverId));
      const ledger = new HistoryImport(join(config.stateDir, 'history.sqlite'));
      ledgers.set(serverId, ledger);
      const remote = serverId === cfg.daemonServerId ? null : new RemoteWorkspaces(repository, config.stateDir);
      if (remote) unknownFiles.set(serverId, remote.unknownCounts);
      worker = new PaseoCollector(config, {
        state, sdk, client: createCenterClient({ server: cfg.centerUrl, token }), outbox: new Outbox(config.stateDir),
        now: () => new Date(), log,
        history: { ledger, enabled: () => selected(serverId) && prefs.readClosed },
        readContent: agent => selected(serverId) && (prefs.readClosed || isLoaded(agent)),
        workspaceById: remote ? (id, now) => remote.read(id, now) : undefined,
      });
      await worker.start();
      workers.set(serverId, worker);
      log('collecting ' + sourceId + ' via ' + cfg.daemonServerId);
    } catch (err) {
      if (worker) await worker.stop();
      else { await sdk.close(); state?.release(); }
      ledgers.get(serverId)?.close();
      ledgers.delete(serverId);
      throw err;
    }
  }

  async function stop(id: string, worker: PaseoCollector) {
    try { await worker.stop(); }
    finally {
      ledgers.get(id)?.close();
      ledgers.delete(id);
      unknownFiles.delete(id);
      workers.delete(id);
    }
  }

  function savedCounts(id: string) {
    const source = cfg.sources.find(s => s.serverId === id);
    return source ? HistoryImport.savedCounts(join(cfg.stateRoot, source.sourceId, 'history.sqlite')) : { total: 0, completed: 0 };
  }

  server.handle(importProgress, () => ({
    sources: prefs.selectedHosts.map(serverId => ({
      serverId, ...(ledgers.get(serverId)?.counts() ?? savedCounts(serverId)),
      ready: workers.get(serverId)?.historyInventoryReady ?? false,
    })),
    unknownFileCounts: [...unknownFiles].flatMap(([serverId, entries]) =>
      [...entries].map(([workspaceId, fields]) => ({ serverId, workspaceId, ...fields }))),
  }));

  async function reconcile() {
    // Apply deselections even if directory lookup fails.
    for (const [id, worker] of workers) {
      if (!selected(id)) await stop(id, worker);
    }
    if (!prefs.selectedHosts.length || stopped) return;
    for (const id of prefs.selectedHosts) {
      if (!writers.has(id) && !missing.has(id)) {
        missing.add(id);
        console.error('Selected host has no sourceId/tokenFile binding in collector config:', id);
      }
    }
    await local.connect();
    const hosts = await local.hosts.list();
    if (hosts.self.serverId !== cfg.daemonServerId) throw new Error('local daemon serverId mismatch');
    const online = new Set([hosts.self.serverId, ...hosts.hosts.filter(h => h.enabled && h.status === 'online' && h.serverId).map(h => h.serverId)]);
    await Promise.all(cfg.sources.map(async source => {
      const id = source.serverId;
      const existing = workers.get(id);
      if (existing && !online.has(id)) await stop(id, existing);
      if (!existing && selected(id) && online.has(id)) {
        try { await start(source); } catch (err) { console.error(source.sourceId, String(err)); }
      }
    }));
  }
  function refresh() {
    if (stopped) return;
    pending = true;
    if (!current) current = (async () => {
      while (!stopped && pending) {
        pending = false;
        try { await reconcile(); } catch (err) { console.error('collector directory', String(err)); }
      }
    })().finally(() => { current = undefined; if (pending && !stopped) refresh(); });
  }

  let settingsChanged = false;
  function apply(state: Awaited<ReturnType<typeof stored.read>>) {
    prefs = state.status === 'ready' ? state.values : { selectedHosts: [], readClosed: false };
    refresh();
  }
  const unsubscribe = stored.subscribe(state => { settingsChanged = true; apply(state); });
  void stored.read().then(state => { if (!settingsChanged && !stopped) apply(state); }).catch(err => console.error('collector settings', String(err)));
  const timer = setInterval(refresh, 10_000);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await unsubscribe();
    await current;
    try { await Promise.all([...workers].map(([id, w]) => stop(id, w))); }
    finally { await local.close(); }
  };
}
