import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { HistoryImport } from '../../server/collector/history-import.ts';
import type { AgentSnapshot } from '../../server/collector/sdk.ts';

test('the cohort survives waking, retry and reload; only the matching generation completes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'history-import-'));
  const path = join(dir, 'history.sqlite');
  let ledger = new HistoryImport(path);
  const sample = (id: string, status: string, archivedAt?: string) => ({ id, status, updatedAt:'now', archivedAt } as AgentSnapshot);
  try {
    ledger.observe(sample('A','closed'), false);
    ledger.observe(sample('B','idle','yesterday'), false);
    const stamp = ledger.pendingStamp('A')!;
    ledger.observe(sample('A','idle'), true);
    ledger.complete('A',stamp);
    ledger.close();
    expect(HistoryImport.savedCounts(path)).toEqual({total:2,completed:1});
    ledger = new HistoryImport(path);
    const old = ledger.pendingStamp('B')!;
    ledger.observe(sample('B','idle','today'), true);
    ledger.complete('B',old);
    expect(ledger.counts()).toEqual({total:2,completed:1});
    ledger.complete('B',ledger.pendingStamp('B')!);
    expect(ledger.counts()).toEqual({total:2,completed:2});
    ledger.retain(['B']);
    expect(ledger.counts()).toEqual({total:1,completed:1});
  } finally { ledger.close(); rmSync(dir,{recursive:true,force:true}); }
});
