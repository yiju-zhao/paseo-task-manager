import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

import { CREDENTIAL_MODES, LLM_ROLES } from '../../src/shared/model-settings.ts';

const role = z.enum(LLM_ROLES);
const mode = z.enum(CREDENTIAL_MODES);
const change = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('model'), role, model: z.string() }),
  z.object({ kind: z.literal('provider'), mode, secret: z.string().optional() }),
]);

export const modelSettings = defineRpc({
  name: 'models.settings',
  input: z.object({ change: change.optional() }),
  output: z.object({
    roles: z.array(z.object({
      role, label: z.string(), model: z.string(), calls: z.number().int(), failures: z.number().int(),
    })),
    model_options: z.array(z.object({ id: z.string(), label: z.string() })),
    provider: z.object({
      mode, origin: z.enum(['settings', 'config', 'default']),
      stored: z.object({ oauth_token: z.string().max(4).optional(), api_key: z.string().max(4).optional() }),
    }),
    enabled: z.boolean(), pause_reason: z.string().nullable(), paused_until: z.string().nullable(),
  }),
});
