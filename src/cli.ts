#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadCollectorConfig } from './collector/config.ts';
import { runCollector } from './collector/loop.ts';
import { defaultOpenDeps, runOpen } from './lookup/command.ts';

// Server modules (node:sqlite, hono) are loaded only inside the `server` command, with a dynamic
// import: the single-file collector binary is built with bun, which has no node:sqlite, so the
// `collect`, `sessions` and `open` paths must never evaluate them (src/lookup, which `open` runs,
// imports only node built-ins, src/shared and zod). The Paseo collector (and its SDK) is loaded the
// same way, only by `collect-paseo`, so the herdr collector never loads the Paseo SDK.

/** The process-facing side of the CLI, injectable so tests need no network, terminal or exit. */
export type Io = {
  fetch: typeof fetch;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Stops the `server` command (the process entry point relies on SIGINT/SIGTERM instead). */
  signal?: AbortSignal;
};

const DEFAULT_SERVER = 'http://localhost:7718';

const USAGE = `Usage:
  agent-pm server --config <path>                      run the central server
  agent-pm rebuild-index --config <path>               rebuild stored context indexes
  agent-pm collect --config <path>                     run the collector on this machine
  agent-pm collect-paseo --config <path>               run a Paseo collector for one daemon (node 26)
  agent-pm sessions [--server <url>] [--machine <m>]   list sessions known to the central server
  agent-pm open [<短ID>] [--remote split|inline] [--dry-run]   open an agent by short id in herdr
`;

class UsageError extends Error {}

/** Runs one CLI invocation and returns the process exit code: 0 ok, 1 runtime failure, 2 usage error. */
export async function main(argv: string[], io: Io): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case 'server':
        return await runServer(args, io);
      case 'rebuild-index': {
        const path = requireConfig(command, args);
        const { loadServerConfig } = await import('./server/config.ts');
        const { openDb, transaction } = await import('./server/db.ts');
        const { rebuildSearchIndex } = await import('./server/search.ts');
        const { rebuildTurns } = await import('./server/turns.ts');
        const db = openDb(loadServerConfig(path).dbPath);
        try {
          transaction(db, () => {
            db.exec('DELETE FROM turn_items; DELETE FROM turns');
            for (const row of db.prepare("SELECT DISTINCT session_key FROM source_events WHERE source_id NOT LIKE 'herdr:%'").all()) {
              rebuildTurns(db, String(row.session_key));
            }
            rebuildSearchIndex(db);
          });
          io.stdout('索引重建完成\n');
        } finally {
          db.close();
        }
        return 0;
      }
      case 'collect':
        return await runCollect(args, io);
      case 'collect-paseo':
        return await runCollectPaseo(args, io);
      case 'sessions':
        return await runSessions(args, io);
      case 'open':
        return await runOpen(args, io, defaultOpenDeps);
      case '-h':
      case '--help':
      case 'help':
        io.stdout(USAGE);
        return 0;
      case undefined:
        throw new UsageError('missing command');
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`agent-pm: ${err.message}\n\n${USAGE}`);
      return 2;
    }
    io.stderr(`agent-pm: ${describeError(err)}\n`);
    return 1;
  }
}

function parseOptions<const O extends Record<string, { type: 'string' }>>(args: string[], options: O) {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals: false }).values;
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

function requireConfig(command: string, args: string[]): string {
  const { config } = parseOptions(args, { config: { type: 'string' } });
  if (!config) throw new UsageError(`${command} requires --config <path>`);
  return config;
}

async function runServer(args: string[], io: Io): Promise<number> {
  const configPath = requireConfig('server', args);
  if (process.versions.bun) {
    throw new Error('the server needs node:sqlite, which bun lacks: run it with node (node src/cli.ts server --config <path>)');
  }
  const { dirname } = await import('node:path');
  const { loadServerConfig } = await import('./server/config.ts');
  const { startCenter } = await import('./server/center.ts');
  const center = await startCenter({
    config: loadServerConfig(configPath),
    configDir: dirname(configPath),
    webDir: fileURLToPath(new URL('../dist/web', import.meta.url)),
    log: line => io.stdout(line + '\n'),
  });
  const stopped = Promise.withResolvers<void>();
  const stop = () => stopped.resolve();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  io.signal?.addEventListener('abort', stop, { once: true });
  try {
    if (!io.signal?.aborted) await stopped.promise;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    io.signal?.removeEventListener('abort', stop);
    await center.stop();
  }
  return 0;
}

async function runCollect(args: string[], io: Io): Promise<number> {
  const config = loadCollectorConfig(requireConfig('collect', args));
  io.stdout(`agent-pm collect: machine ${config.machine} -> ${config.server}\n`);
  return runCollector(config);
}

async function runCollectPaseo(args: string[], io: Io): Promise<number> {
  const configPath = requireConfig('collect-paseo', args);
  let mod: typeof import('./paseo-collector/cli.ts');
  try {
    mod = await import('./paseo-collector/cli.ts');
  } catch (err) {
    throw new Error(
      `the Paseo collector cannot load here (${describeError(err)}); run it with node 26 from the repository: node src/cli.ts collect-paseo --config <path>`,
      { cause: err },
    );
  }
  return mod.runPaseoCollect(configPath, io);
}

const SessionList = z.array(
  z.object({
    short_id: z.string(),
    machine: z.string(),
    agent_kind: z.string(),
    effective_status: z.string(),
    title: z.string(),
  }),
);

async function runSessions(args: string[], io: Io): Promise<number> {
  const { server = DEFAULT_SERVER, machine } = parseOptions(args, { server: { type: 'string' }, machine: { type: 'string' } });
  let url: URL;
  try {
    url = new URL('sessions', server.endsWith('/') ? server : `${server}/`);
  } catch {
    throw new UsageError(`invalid --server url "${server}"`);
  }
  if (machine) url.searchParams.set('machine', machine);

  let response: Response;
  try {
    response = await io.fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new Error(`cannot reach ${server}: ${describeError(err)}`);
  }
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const parsed = SessionList.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new Error(`unexpected response from ${url}: expected a JSON list of sessions`);

  if (parsed.data.length === 0) {
    io.stdout('没有 session\n');
    return 0;
  }
  const rows = [
    ['短ID', '机器', 'agent', '状态', '标题'],
    ...parsed.data.map((s) => [s.short_id, s.machine, s.agent_kind, s.effective_status, s.title.replace(/\s+/g, ' ').trim()]),
  ];
  const widths = [0, 1, 2, 3].map((col) => Math.max(...rows.map((row) => displayWidth(row[col]!))));
  io.stdout(rows.map((row) => [...row.slice(0, 4).map((cell, col) => pad(cell, widths[col]!)), row[4]!].join('  ') + '\n').join(''));
  return 0;
}

/** Terminal columns a string occupies: CJK and full-width characters take two. */
function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return width;
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(width - displayWidth(text));
}

/** Message of an error plus the innermost cause, e.g. `fetch failed: connect ECONNREFUSED 127.0.0.1:7718`. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause;
  if (cause === undefined) return err.message;
  // happy-eyeballs failures arrive as an AggregateError with an empty message
  const inner = cause instanceof AggregateError && !cause.message ? cause.errors[0] : cause;
  const detail = inner instanceof Error ? inner.message || (inner as { code?: string }).code : String(inner);
  return detail && !err.message.includes(detail) ? `${err.message}: ${detail}` : err.message;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), {
    fetch,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
