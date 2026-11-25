import { defineRpc, defineSettings } from '@getpaseo/plugin';
import { z } from 'zod';

export const settings = defineSettings({
  id: 'collection',
  scope: 'host',
  version: 1,
  schema: z.object({
    selectedHosts: z.array(z.string().min(1)).default([]),
    readClosed: z.boolean().default(false),
  }),
});
export type Preferences = z.output<typeof settings.schema>;


export const importProgress = defineRpc({
  name: 'history.progress',
  input: z.object({}),
  output: z.object({
    sources: z.array(z.object({ serverId: z.string(), total: z.number(), completed: z.number(), ready: z.boolean() })),
    unknownFileCounts: z.array(z.object({ serverId: z.string(), workspaceId: z.string(), isDirty: z.boolean().nullable(),
      root: z.string(), branch: z.string().nullable(), ahead: z.number().nullable(), behind: z.number().nullable() })),
  }),
});
