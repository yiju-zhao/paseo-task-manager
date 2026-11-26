import type { DatabaseSync } from 'node:sqlite';
import { acquireLease, applyPaseoSnapshot, bodyHash, commitBatch, getCheckpoint, IngestError, releaseLease, type PaseoSource } from '../../src/server/ingest-repo.ts';
import { RefusedError, FatalError, type CenterClient } from './collector/client.ts';

export function inProcessClient(db: DatabaseSync, source: PaseoSource, now = () => new Date(), afterBatch?: () => void): CenterClient {
  async function submit<T>(sourceId: string, write: () => T): Promise<T> {
    if (sourceId !== source.sourceId) throw new FatalError('source identity mismatch');
    try {
      return write();
    } catch (err) {
      if (!(err instanceof IngestError)) throw err;
      if (err.status === 409 && err.code !== 'identity_mismatch') {
        throw new RefusedError(err.status, { error: err.code, message: err.message, checkpoint: err.checkpoint });
      }
      throw new FatalError(err.code, { cause: err });
    }
  }
  return {
    lease: req => submit(req.source_id, () => acquireLease(db, source, req, now())),
    releaseLease: writer => submit(writer.source_id, () => releaseLease(db, source, writer, now())),
    snapshot: body => submit(body.source_id, () => {
      if (body.daemon.server_id && body.daemon.server_id !== source.serverId) throw new FatalError('identity_mismatch');
      return applyPaseoSnapshot(db, source, body, now());
    }),
    batch: body => submit(body.source_id, () => {
      const ack = commitBatch(db, source, body, bodyHash(body), now());
      afterBatch?.();
      return ack;
    }),
    checkpoint: async id => getCheckpoint(db, source, id),
  };
}
