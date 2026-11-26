import type { RpcInput } from '@getpaseo/plugin';

import type { RunningCenter } from '../../src/server/center.ts';
import type { modelSettings } from '../shared/models.ts';

export function manageModels(center: RunningCenter, { change }: RpcInput<typeof modelSettings>) {
  const settings = center.settings;
  if (change?.kind === 'model') settings.setModels({ [change.role]: change.model });
  if (change?.kind === 'provider') settings.setProvider(change.mode, change.secret);
  const { roles, models, model_options, provider } = settings.view();
  const usage = settings.callsLastWeek();
  const { enabled, pause_reason, paused_until } = center.status();
  return {
    roles: roles.map(({ role, label }) => {
      const recent = usage.find(row => row.role === role);
      return { role, label, model: models[role], calls: recent?.calls ?? 0, failures: recent?.failures ?? 0 };
    }),
    model_options, provider, enabled, pause_reason, paused_until,
  };
}
