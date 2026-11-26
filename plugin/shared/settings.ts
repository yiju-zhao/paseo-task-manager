import { defineRpc, defineSettings } from '@getpaseo/plugin';
import { z } from 'zod';
import { DEFAULT_TOOL_LIMIT } from '../../src/shared/storage.ts';

export const settings = defineSettings({
  id: 'collection',
  scope: 'host',
  version: 1,
  schema: z.object({
    selectedHosts: z.array(z.string().min(1)).default([]),
    readClosed: z.boolean().default(false),
    toolLimit: z.number().int().positive().default(DEFAULT_TOOL_LIMIT),
  }),
});
export type Preferences = z.output<typeof settings.schema>;


export const importProgress = defineRpc({
  name: 'history.progress',
  input: z.object({}),
  output: z.object({
    lastSync: z.array(z.object({ serverId: z.string(), at: z.string().nullable() })),
    sources: z.array(z.object({ serverId: z.string(), total: z.number(), completed: z.number(), ready: z.boolean() })),
    unknownFileCounts: z.array(z.object({ serverId: z.string(), workspaceId: z.string(), isDirty: z.boolean().nullable(),
      root: z.string(), branch: z.string().nullable(), ahead: z.number().nullable(), behind: z.number().nullable() })),
  }),
});

export const centerStatus = defineRpc({
  name: 'center.status',
  input: z.object({ action: z.enum(['retry', 'fresh']).optional() }),
  output: z.object({ configPath: z.string(), running: z.boolean(), reason: z.string(), canStartFresh: z.boolean() }),
});

export const storageState = defineRpc({
  name: 'storage.usage',
  input: z.object({ previewLimit: z.number().int().positive().optional() }),
  output: z.object({ used: z.number(), limit: z.number(), oldest: z.string().nullable(), blocked: z.boolean(),
    preview: z.object({ used: z.number(), clearBytes: z.number(), oldest: z.string().nullable() }).optional() }).nullable(),
});

export const sourceDirectory = defineRpc({
  name: 'sources.directory',
  input: z.object({ change: z.object({ sourceId: z.string().min(1), retired: z.boolean() }).optional() }),
  output: z.array(z.object({
    sourceId: z.string(), kind: z.enum(['herdr', 'paseo']), machine: z.string(), lastSync: z.string().nullable(),
    state: z.enum(['never_reported', 'offline', 'daemon_down', 'ok', 'retired']),
  })),
});
