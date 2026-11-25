import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { AgentSnapshot } from './sdk.ts';

/** Per-source cohort. Reading can change closed to idle, so a directory count alone loses unfinished targets. */
export class HistoryImport {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS targets(id TEXT PRIMARY KEY, stamp TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)`);
  }

  observe(agent: AgentSnapshot, importing: boolean): boolean {
    const stamp = agent.archivedAt ? 'archived:' + agent.archivedAt : agent.status === 'closed' ? 'closed:' + agent.updatedAt : null;
    if (stamp !== null) {
      const change = this.db.prepare(`INSERT INTO targets(id,stamp) VALUES (?,?) ON CONFLICT(id) DO UPDATE
        SET stamp=excluded.stamp,done=0 WHERE targets.stamp!=excluded.stamp`).run(agent.id, stamp);
      return Number(change.changes) > 0;
    } else if (!importing) {
      this.db.prepare('DELETE FROM targets WHERE id=? AND done=1').run(agent.id);
    }
    return false;
  }

  /** Only prune after a complete directory scan with missing agents resolved. */
  retain(ids: string[]): void {
    this.db.prepare('DELETE FROM targets WHERE id NOT IN (SELECT value FROM json_each(?))').run(JSON.stringify(ids));
  }
  pendingStamp(id: string): string | undefined {
    return this.db.prepare('SELECT stamp FROM targets WHERE id=? AND done=0').get(id)?.stamp as string | undefined;
  }
  done(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM targets WHERE id=? AND done=1').get(id);
  }
  complete(id: string, stamp: string): void {
    this.db.prepare('UPDATE targets SET done=1 WHERE id=? AND stamp=?').run(id, stamp);
  }
  /** An offline host still contributes its last known counts. Its inventory cannot be declared complete. */
  static savedCounts(path: string): { total: number; completed: number } {
    if (!existsSync(path)) return { total: 0, completed: 0 };
    const db = new DatabaseSync(path, { readOnly: true });
    try { return HistoryImport.queryCounts(db); } finally { db.close(); }
  }
  counts() { return HistoryImport.queryCounts(this.db); }
  private static queryCounts(db: DatabaseSync): { total: number; completed: number } {
    return db.prepare('SELECT count(*) AS total, coalesce(sum(done),0) AS completed FROM targets').get() as { total: number; completed: number };
  }
  close(): void { this.db.close(); }
}
