import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

import { createPaseoClient } from '@getpaseo/client';
import type { PluginServerContext } from '@getpaseo/plugin/server';

import { startCenter, type RunningCenter } from '../../src/server/center.ts';
import type { PaseoSource } from '../../src/server/ingest-repo.ts';
import { ToolStorage } from '../../src/server/tool-storage.ts';
import { centerStatus, importProgress, storageState, settings, type Preferences } from '../shared/settings.ts';
import { PaseoCollectorConfig } from './collector/config.ts';
import { HistoryImport } from './collector/history-import.ts';
import { PaseoCollector } from './collector/loop.ts';
import { Outbox } from './collector/outbox.ts';
import { agentReads, isLoaded } from './collector/sdk.ts';
import { StateDir } from './collector/state-store.ts';
import { pluginPaths } from './config.ts';
import { DatabaseProblem, openPluginDatabase, pluginConfig } from './database.ts';
import { inProcessClient } from './in-process.ts';
import { openSource, optionalFileCounter } from './route.ts';
import { selectSource } from './sources.ts';
import { upstreamReader } from './upstream.ts';
import { RemoteWorkspaces, type UnknownFileCount } from './workspaces.ts';

declare const CHECKOUT_WEB_DIR: string;

export default function contribute(server: Pick<PluginServerContext, 'registerSettings' | 'handle'>) {
  const stored = server.registerSettings(settings);
  const cfg = pluginPaths();
  const local = createPaseoClient({ url: cfg.daemonUrl, clientId: 'paseo-task-manager-' + randomUUID(), connectTimeoutMs: 5000 });
  const writers = new Map<string, string>();
  const workers = new Map<string, PaseoCollector>();
  const ledgers = new Map<string, HistoryImport>();
  const unknownFiles = new Map<string, Map<string, UnknownFileCount>>();
  let prefs: Preferences = settings.schema.parse({});
  let settingsReady = false;
  let storage: ToolStorage | undefined;
  function enforceLimit() {
    if (settingsReady && !stopped) void storage?.schedule(prefs.toolLimit).catch(err => console.error('工具详情清理失败', String(err)));
  }
  let stopped = false;
  let pending = false;
  let current: Promise<void> | undefined;
  const selected = (id: string) => !stopped && prefs.selectedHosts.includes(id);
  const log = (s: string) => console.info(s);
  const upstream = upstreamReader(async id => {
    await local.connect();
    const api = await local.hosts.client(id);
    return { ...agentReads(api.agents), close: () => api.dispose() };
  }, selected, () => prefs.readClosed);

  let center: RunningCenter | undefined;
  let config: ReturnType<typeof pluginConfig>;
  let reason = '';
  let canStartFresh = false;
  let starting: Promise<void> | undefined;
  function boot(fresh = false) {
    if (center || stopped) return;
    starting ??= (async () => {
      config = Object.assign(pluginConfig(cfg), { selectedPaseoHosts: () => prefs.selectedHosts });
      center = await startCenter({ config, configDir: dirname(cfg.configPath), webDir: CHECKOUT_WEB_DIR, log, upstream, afterBatch: enforceLimit, toolUsage: () => storage?.status(),
        openDatabase: path => openPluginDatabase(cfg, path, fresh) });
      storage = new ToolStorage(center.db);
      enforceLimit();
      reason = '';
      canStartFresh = false;
    })().catch(err => {
      reason = err instanceof Error ? err.message : String(err);
      canStartFresh = err instanceof DatabaseProblem && err.canStartFresh;
      console.error('中心未启动', reason);
    }).finally(() => { starting = undefined; });
    return starting;
  }
  void boot();
  server.handle(storageState, async ({ previewLimit }) => {
    if (!storage || !settingsReady) return null;
    const preview = previewLimit === undefined ? undefined : await storage.preview(previewLimit);
    return { ...storage.status(), preview };
  });
  server.handle(centerStatus, async ({ action }) => {
    if (action === 'retry' || (action === 'fresh' && canStartFresh)) await boot(action === 'fresh');
    return { configPath: cfg.configPath, running: Boolean(center), reason, canStartFresh };
  });

  async function start(source: PaseoSource, center: RunningCenter) {
    const { serverId, sourceId } = source;
    if (!writers.has(serverId)) writers.set(serverId, 'paseo-' + randomUUID());
    const count = optionalFileCounter(cfg.daemonUrl, cfg.daemonServerId, serverId);
    const { sdk, repository } = await openSource(local, serverId, () => selected(serverId), () => prefs.readClosed, count);
    let state: StateDir | undefined;
    let worker: PaseoCollector | undefined;
    try {
      const config = PaseoCollectorConfig.parse({
        ...source, paseo: { url: cfg.daemonUrl, serverId },
        stateDir: join(cfg.stateRoot, sourceId), readArchivedTracked: true, includeArchivedHistory: true,
      });
      state = StateDir.open(config.stateDir, { sourceId, serverId, server: cfg.configPath }, writers.get(serverId));
      const ledger = new HistoryImport(join(config.stateDir, 'history.sqlite'));
      ledgers.set(serverId, ledger);
      const remote = serverId === cfg.daemonServerId ? null : new RemoteWorkspaces(repository, config.stateDir);
      if (remote) unknownFiles.set(serverId, remote.unknownCounts);
      worker = new PaseoCollector(config, {
        state, sdk, client: inProcessClient(center.db, source, undefined, enforceLimit), outbox: new Outbox(config.stateDir),
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
    const row = center?.db.prepare('SELECT source_id FROM ingest_sources WHERE server_id = ?').get(id);
    return row ? HistoryImport.savedCounts(join(cfg.stateRoot, String(row.source_id), 'history.sqlite')) : { total: 0, completed: 0 };
  }

  server.handle(importProgress, () => ({
    lastSync: (center?.db.prepare("SELECT server_id, last_snapshot_at FROM ingest_sources WHERE kind='paseo' AND server_id IS NOT NULL").all() ?? [])
      .map(row => ({ serverId: String(row.server_id), at: row.last_snapshot_at ? String(row.last_snapshot_at) : null })),
    sources: prefs.selectedHosts.map(serverId => ({
      serverId, ...(ledgers.get(serverId)?.counts() ?? savedCounts(serverId)),
      ready: workers.get(serverId)?.historyInventoryReady ?? false,
    })),
    unknownFileCounts: [...unknownFiles].flatMap(([serverId, entries]) =>
      [...entries].map(([workspaceId, fields]) => ({ serverId, workspaceId, ...fields }))),
  }));

  async function reconcile() {
    await starting;
    const running = center;
    if (!running) return;
    // Apply deselections even if directory lookup fails.
    for (const [id, worker] of workers) {
      if (!selected(id)) await stop(id, worker);
    }
    if (!prefs.selectedHosts.length || stopped) return;
    await local.connect();
    const hosts = await local.hosts.list();
    if (hosts.self.serverId !== cfg.daemonServerId) throw new Error('local daemon serverId mismatch');
    const online = new Set([hosts.self.serverId, ...hosts.hosts.filter(h => h.enabled && h.status === 'online' && h.serverId).map(h => h.serverId)]);
    await Promise.all(prefs.selectedHosts.map(async id => {
      const existing = workers.get(id);
      if (existing && !online.has(id)) await stop(id, existing);
      if (existing || !selected(id)) return;
      const host = [hosts.self, ...hosts.hosts].find(h => h.serverId === id);
      if (!host) return;
      const source = selectSource(running.db, id, host.label || id, Object.keys(config.paseoCollectors ?? {}));
      if (!online.has(id)) return;
      try { await start(source, running); } catch (err) { console.error(source.sourceId, String(err)); }
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
    const prior = settingsReady ? prefs.toolLimit : undefined;
    settingsReady = state.status === 'ready';
    prefs = state.status === 'ready' ? state.values : settings.schema.parse({});
    if (prior !== prefs.toolLimit) enforceLimit();
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
    finally {
      await local.close();
      await starting;
      await storage?.stop();
      await center?.stop();
    }
  };
}
