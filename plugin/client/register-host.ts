import type { PaseoHostActions } from '@getpaseo/client';

export async function registerHost(hosts: Pick<PaseoHostActions, 'add'>, label: string, connection: string): Promise<string> {
  try {
    const host = await hosts.add({ connection: connection.trim(), label: label.trim() || undefined });
    return host.error?.code ?? '';
  } catch (err) {
    // Error messages can echo the connection, including a pairing secret.
    return err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : 'registration_failed';
  }
}
