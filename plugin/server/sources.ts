import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../../src/server/db.ts';

export function selectSource(db: DatabaseSync, serverId: string, name: string, reserved: string[] = []) {
  return transaction(db, () => {
    const existing = db.prepare("SELECT source_id, machine FROM ingest_sources WHERE kind='paseo' AND server_id=?").get(serverId);
    if (existing) return { serverId, sourceId: String(existing.source_id), machine: String(existing.machine) };
    const slug = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'host';
    const prefix = 'paseo-' + slug;
    let sourceId = prefix;
    const lookup = db.prepare('SELECT 1 FROM ingest_sources WHERE source_id=?');
    for (let suffix = 2; reserved.includes(sourceId) || lookup.get(sourceId); suffix++) sourceId = prefix + '-' + suffix;
    db.prepare("INSERT INTO ingest_sources(source_id, kind, machine, server_id) VALUES (?, 'paseo', ?, ?)").run(sourceId, name, serverId);
    return { serverId, sourceId, machine: name };
  });
}
