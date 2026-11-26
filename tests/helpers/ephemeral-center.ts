import { vi } from 'vitest';

import * as center from '../../src/server/center.ts';

const start = center.startCenter;

/** Keep production config validation intact while letting the kernel choose the test listener's port. */
export function nextCenterPort(): Promise<number> {
  const listening = Promise.withResolvers<center.RunningCenter>();
  vi.spyOn(center, 'startCenter').mockImplementationOnce(options => {
    const started = start({ ...options, config: { ...options.config, listen: '127.0.0.1', port: 0 } });
    listening.resolve(started);
    return started;
  });
  return listening.promise.then(running => running.port);
}
