import { afterEach, expect, test, vi } from 'vitest';
import { openDb } from '../../src/server/db.ts';
import { selectSource } from '../server/sources.ts';
import { registerHost } from '../client/register-host.ts';
import { settings } from '../shared/settings.ts';

const db = openDb(':memory:');
afterEach(() => db.exec('DELETE FROM ingest_sources'));

test('A known daemon retains its source ID and original machine name.', () => {
  db.prepare("INSERT INTO ingest_sources(source_id, kind, machine, server_id) VALUES ('legacy', 'paseo', 'original', 'srv_test')").run();
  expect(selectSource(db, 'srv_test', 'renamed')).toEqual({ serverId: 'srv_test', machine: 'original', sourceId: 'legacy' });
});

test('A new daemon gets a readable source ID and its unmodified display name.', () => {
  expect(selectSource(db, 'srv_test', 'Lab Node')).toEqual({ serverId: 'srv_test', machine: 'Lab Node', sourceId: 'paseo-lab-node' });
});

test('Names with identical slugs get distinct persistent source IDs.', () => {
  const first = selectSource(db, 'srv_one', 'Lab node');
  const second = selectSource(db, 'srv_two', 'Lab-node');
  expect(second.sourceId).not.toBe(first.sourceId);
  expect(selectSource(db, 'srv_two', 'renamed')).toEqual(second);
});

test('Registering a machine only submits its connection and leaves selection at its existing default.', async () => {
  const add = vi.fn().mockResolvedValue({});
  const link = 'https://pair.invalid/#fixture';
  expect(await registerHost({ add }, 'Fixture', link)).toBe('');
  expect(add).toHaveBeenCalledWith({ label: 'Fixture', connection: link });
  expect(settings.schema.parse({}).selectedHosts).toEqual([]);
});

test('A failed registration returns only the Paseo error code.', async () => {
  const err = Object.assign(new Error('message contains a private pairing link'), { code: 'pair_failed' });
  expect(await registerHost({ add: vi.fn().mockRejectedValue(err) }, 'Fixture', 'secret')).toBe('pair_failed');
});
