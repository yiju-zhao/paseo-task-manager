import type { DatabaseSync } from 'node:sqlite';

import type { PluginServerContext } from '@getpaseo/plugin/server';

import { ContextAddressError, parseAddress } from '../../src/context/address.ts';
import { markOverviewRead, readOverview, readSession, readTurn } from '../../src/context/read.ts';
import { explicitItem } from '../../src/context/upstream.ts';
import { getEvidence } from '../../src/domain/evidence.ts';
import { getProject, listProjects, listQuestions, sessionLinks } from '../../src/domain/read.ts';
import { defaultDeps } from '../../src/domain/types.ts';
import type { OverviewSources } from '../../src/mcp/context-tools.ts';
import type { ChangeFeed } from '../../src/server/change-feed.ts';
import { configuredSources } from '../../src/server/coverage.ts';
import { searchContext } from '../../src/server/search.ts';
import { listSessions } from '../../src/server/sessions-repo.ts';
import {
  boardChanges, boardDirectory, boardQuestions, boardEvidence, boardItem, boardOverview, boardProject, boardProjects, boardSearch,
  boardSession, boardTurn, boardWorkspace,
} from '../shared/board.ts';

type Available = { db: DatabaseSync; feed: ChangeFeed; sources: OverviewSources };
type BoardOptions = {
  center(): Promise<Available | { reason: string }>;
  now(): Date;
  whenReady(listen: () => void): () => void;
};

type AgentLocation = { agentId: string; serverId: string };
const agentObservation = `SELECT o.external_id AS agentId, s.server_id AS serverId FROM session_sources o
  JOIN ingest_sources s USING(source_id) JOIN sessions session ON session.key=o.session_key
  WHERE s.kind='paseo' AND s.server_id IS NOT NULL AND o.session_key=?
  ORDER BY (o.source_id=session.content_owner) DESC, o.last_seen DESC, o.external_id LIMIT 1`;

export function registerBoard(server: Pick<PluginServerContext, 'handle'>, options: BoardOptions): void {
  async function read<V>(query: (center: Available, now: Date) => V | Promise<V>): Promise<{ value: V } | { reason: string }> {
    const center = await options.center();
    if ('reason' in center) return center;
    return { value: await query(center, options.now()) };
  }
  server.handle(boardOverview, ({ markRead }) => read(({ db, sources }, now) => {
    const overview = readOverview(db, now, 'panel', sources);
    const sessions = listSessions(db, {}, now);
    const byKey = new Map(sessions.map(session => [session.key, session]));
    const byAddress = new Map(sessions.map(session => ['s:' + session.short_id, session]));
    const agent = db.prepare(agentObservation);
    const question = db.prepare('SELECT project_id, session_key FROM questions WHERE id=?');
    const targets = Object.fromEntries(overview.pending.map(({ ref }) => {
      const q = ref.startsWith('q_') ? question.get(ref) : undefined;
      const session = q?.session_key ? byKey.get(String(q.session_key)) : byAddress.get(ref);
      return [ref, { address: session ? 's:' + session.short_id : null, agent: session ? (agent.get(session.key) as AgentLocation | undefined) ?? null : null,
        project: q?.project_id ? String(q.project_id) : ref.startsWith('p_') ? ref : null }];
    }));
    const gaps = new Map(overview.sources.map(s => [s.id, s]));
    const configured = configuredSources(db, sources.config);
    const observations = sessions.flatMap(s => s.sources).filter(o => configured.has(o.source_id));
    const contentGaps = observations.reduce((count, o) => count + o.gaps, 0);
    const incomplete = observations.filter(o => o.content_state && o.content_state !== 'current').length;
    const machines = [...configured].map(([id, source]) => ({
      id, machine: source.machine, state: gaps.get(id)?.state ?? 'ok', last_sync: gaps.get(id)?.last_sync ?? null,
    }));
    const hosts = sources.config.paseoHostSelection?.();
    if (markRead) markOverviewRead(db, 'panel', now, overview.last_event_id);
    return { overview, targets, contentGaps, incomplete, at: now.toISOString(), machines, excluded: hosts ? hosts.total - hosts.selected.length : 0,
      usage: sources.toolUsage?.() ?? null };
  }));
  server.handle(boardQuestions, () => read(({ db }, now) => listQuestions(db, { ...defaultDeps(), now: () => now }, { status: 'pending' })));
  server.handle(boardDirectory, () => read(({ db }, now) => listSessions(db, {}, now).map(({ key, short_id, title, machine, ignored }) => ({ key, short_id, title, machine, ignored: !!ignored }))));
  server.handle(boardProjects, () => read(({ db }, now) => listProjects(db, now, {})));
  server.handle(boardProject, ({ id }) => read(({ db }, now) => getProject(db, now, id)));
  server.handle(boardSearch, ({ query }) => read(({ db }) => searchContext(db, query, { scope: 'all', limit: 20 })));
  server.handle(boardSession, ({ address, before }) => read(({ db }, now) => {
    const parsed = parseAddress(address);
    if (parsed.kind !== 'session') throw new ContextAddressError('需要 session 地址');
    const session = readSession(db, now, parsed.session, { before });
    const agent = db.prepare(agentObservation).get(session.key) as AgentLocation | undefined;
    const ignored = Boolean(db.prepare('SELECT ignored FROM sessions WHERE key=?').get(session.key)!.ignored);
    return { session, agent: agent ?? null, ignored, links: sessionLinks(db).get(session.key) ?? [] };
  }));
  server.handle(boardTurn, ({ address }) => read(({ db }) => {
    const parsed = parseAddress(address);
    if (parsed.kind !== 'turn') throw new ContextAddressError('需要回合地址');
    return readTurn(db, parsed.session, parsed.turn);
  }));
  server.handle(boardItem, ({ address, offset }) => read(({ db, sources }) => {
    const parsed = parseAddress(address);
    if (parsed.kind !== 'item') throw new ContextAddressError('需要回合条目地址');
    return explicitItem(db, parsed.session, parsed.turn, parsed.item, offset, sources.upstream);
  }));
  server.handle(boardEvidence, ({ ref }) => read(({ db }, now) => {
    const base = ref.split('#', 1)[0];
    const [kind, id] = base.split(':');
    if (kind !== 'event' && kind !== 'question') return getEvidence(db, now, ref.startsWith('s:') ? ref : base);
    const sql = kind === 'event' ? 'SELECT op AS text, reason AS detail, occurred_at AS at, project_id FROM events WHERE id=?'
      : 'SELECT prompt AS text, context AS detail, created_at AS at, project_id FROM questions WHERE id=?';
    const entry = db.prepare(sql).get(id) as { text: string; detail: string | null; at: string; project_id: string | null } | undefined;
    return entry ? { kind, ...entry } : null;
  }));
  server.handle(boardWorkspace, ({ directory, serverId }) => read(({ db }, now) => {
    const sessions = db.prepare(`SELECT DISTINCT o.session_key FROM session_sources o JOIN ingest_sources s USING(source_id)
      WHERE s.kind='paseo' AND s.server_id=? AND o.cwd=?`).all(serverId, directory);
    if (!sessions.length) return [];
    const links = sessionLinks(db);
    const ids = new Set(sessions.flatMap(o => links.get(String(o.session_key)) ?? []).map(p => p.id));
    return ids.size ? listProjects(db, now, {}).filter(p => ids.has(p.id)) : [];
  }));
  server.handle(boardChanges, (_, { push, signal }) => {
    let unsubscribe: (() => void) | undefined;
    const emit = (change: 'ready' | 'events' | 'sessions' | 'questions' | 'status') =>
      void push(change).catch(error => { if (!signal.aborted) console.error('看板通知失败', error); });
    async function connect() {
      const center = await options.center();
      if (signal.aborted || unsubscribe) return;
      if (!('reason' in center)) unsubscribe = center.feed.subscribe(msg => { if (msg.type !== 'hello') emit(msg.type); });
      emit('ready');
    }
    const untilReady = options.whenReady(() => void connect());
    signal.addEventListener('abort', () => { untilReady(); unsubscribe?.(); }, { once: true });
    void connect();
  });
}
