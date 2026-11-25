import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { transaction } from './db.ts';
import { DEFAULT_TOOL_LIMIT } from '../shared/storage.ts';

export type ToolUsage = { used: number; limit: number; oldest: string | null; blocked: boolean };

const PAGE = 64;
const AGE = "coalesce(e.ts, e.received_at, '')";
const direct = (event: string) => `EXISTS (SELECT 1 FROM chunk_sources x WHERE x.source_event_id=${event}.id)
  AND NOT EXISTS (SELECT 1 FROM chunk_sources x LEFT JOIN chunks c ON c.id=x.chunk_id WHERE x.source_event_id=${event}.id
    AND coalesce(c.digested,0)<>1 AND c.digest_block_id IS NULL)`;
const ELIGIBLE = `CASE WHEN EXISTS (SELECT 1 FROM chunk_sources x WHERE x.source_event_id=e.id)
  THEN (${direct('e')}) ELSE EXISTS (
    SELECT 1 FROM source_events v WHERE v.session_key=e.session_key AND v.event_key=e.event_key AND v.kind='tool'
      AND ${direct('v')} AND CASE WHEN json_extract(v.meta,'$.detail_cleared_at') IS NULL THEN
        json_extract(v.meta,'$.tool.input') IS json_extract(e.meta,'$.tool.input') AND
        json_extract(v.meta,'$.tool.output') IS json_extract(e.meta,'$.tool.output') AND
        json_extract(v.meta,'$.tool.error') IS json_extract(e.meta,'$.tool.error')
      ELSE json_extract(v.meta,'$.detail_signature') = tool_detail_signature(e.meta) END
  ) END`;

export class ToolStorage {
  private readonly db: DatabaseSync;
  private limit = DEFAULT_TOOL_LIMIT;
  private blocked = false;
  private stopping = false;
  private pending = false;
  private work?: Promise<void>;

  constructor(db: DatabaseSync) {
    this.db = db;
    // Retain a comparison witness after a directly processed version loses its bytes.
    db.function('tool_detail_signature', { deterministic: true }, meta => {
      const { tool } = JSON.parse(String(meta)) as { tool: { input: string; output: string; error: string | null } };
      return createHash('sha256').update(JSON.stringify([tool.input, tool.output, tool.error])).digest('hex');
    });
  }

  status(): ToolUsage {
    const row = this.db.prepare(`SELECT used, (SELECT ${AGE} FROM source_events e WHERE detail_bytes>0 ORDER BY ${AGE}, e.id LIMIT 1) AS oldest FROM tool_detail_usage`).get()!;
    return { used: Number(row.used), limit: this.limit, oldest: row.oldest ? String(row.oldest).slice(0, 10) : null, blocked: this.blocked };
  }

  preview(limit: number) { return this.scan(limit, false); }

  schedule(limit: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.limit = limit;
    this.pending = true;
    this.work ??= (async () => {
      do {
        await setImmediate();
        this.pending = false;
        if (this.stopping) return;
        const cap = this.limit;
        const result = await this.scan(cap, true);
        if (!this.stopping && cap === this.limit) this.blocked = this.status().used > cap && result.exhausted;
      } while (this.pending && !this.stopping);
    })().finally(() => { this.work = undefined; });
    return this.work;
  }

  async stop() {
    this.stopping = true;
    await this.work;
  }

  private async scan(limit: number, apply: boolean) {
    const { used, oldest } = this.status();
    if (used <= limit) return { used, clearBytes: 0, oldest, exhausted: false };
    const target = Math.floor(limit * 0.9);
    const next = this.db.prepare(`SELECT e.id, ${AGE} AS age, e.detail_bytes AS bytes, ${ELIGIBLE} AS eligible
      FROM source_events e WHERE e.detail_bytes>0 AND (${AGE},e.id)>(?,?) ORDER BY ${AGE},e.id LIMIT ?`);
    const clear = this.db.prepare(`UPDATE source_events SET meta=json_set(meta,
      '$.detail_signature',tool_detail_signature(meta), '$.input_preview',substr(json_extract(meta,'$.tool.input'),1,200),
      '$.detail_cleared_at',?, '$.tool.input','', '$.tool.output','', '$.tool.error',NULL) WHERE id=?`);
    let age = '';
    let id = 0;
    let clearBytes = 0;
    let retained: string | null = null;
    let exhausted = false;
    while (!this.stopping && (!apply || this.limit === limit)) {
      const page = next.all(age, id, PAGE);
      const ids: number[] = [];
      for (const row of page) {
        age = String(row.age);
        id = Number(row.id);
        if (row.eligible && used - clearBytes > target) {
          ids.push(id);
          clearBytes += Number(row.bytes);
        } else {
          retained ??= age.slice(0, 10);
        }
      }
      if (apply && ids.length) {
        const at = new Date().toISOString();
        transaction(this.db, () => { for (const event of ids) clear.run(at, event); });
      }
      if (page.length < PAGE) { exhausted = true; break; }
      if (used - clearBytes <= target && retained !== null) break;
      // Give HTTP requests and a changed limit a turn between bounded SQLite transactions.
      await setImmediate();
    }
    return { used, clearBytes, oldest: retained || null, exhausted };
  }
}
