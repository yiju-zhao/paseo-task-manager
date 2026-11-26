import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

import { CREDENTIAL_MODES, LLM_ROLES } from '../../src/shared/model-settings.ts';

const role = z.enum(LLM_ROLES);
const mode = z.enum(CREDENTIAL_MODES);
const steward = z.object({ provider: z.literal('claude'), model: z.string().min(1) });
const change = z.discriminatedUnion('kind', [
  steward.extend({ kind: z.literal('steward') }),
  z.object({ kind: z.literal('model'), role, model: z.string() }),
  z.object({ kind: z.literal('provider'), mode, secret: z.string().optional() }),
]);

export const modelSettings = defineRpc({
  name: 'models.settings',
  input: z.object({ change: change.optional() }),
  output: z.object({
    steward,
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

export const askSteward = defineRpc({ name: 'steward.create', input: z.strictObject({ question: z.string().optional(), projectId: z.string().min(1).optional(), requestKey: z.string().min(1).max(128).optional() }),
  output: z.object({ serverId: z.string(), agentId: z.string() }) });
