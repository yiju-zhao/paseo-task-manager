import { z } from 'zod';

/**
 * A machine label as used in collector and server configs. It becomes part of pending session keys
 * (`pending:<machine>:<terminal>`), so `:` and whitespace would make every such key invalid.
 */
export const MachineLabel = z
  .string()
  .regex(/^[A-Za-z0-9._-]+$/, 'machine label must be non-empty and contain only letters, digits, ".", "_" and "-"');
export type MachineLabel = z.infer<typeof MachineLabel>;

export const LiveStatus = z.enum(['idle', 'working', 'blocked', 'done', 'unknown']);
export type LiveStatus = z.infer<typeof LiveStatus>;
