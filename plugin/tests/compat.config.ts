import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const checkout = process.env.AGENT_PM_CHECKOUT ?? resolve(import.meta.dirname, '../..');
if (!existsSync(resolve(checkout, 'tests/helpers/center.ts'))) {
  throw new Error('Set AGENT_PM_CHECKOUT to an agent-pm source checkout with its development dependencies installed.');
}
export default defineConfig({
  resolve: { alias: { '@agent-pm': resolve(checkout) } },
  test: { include: ['tests/**/*.compat.test.ts'] },
});
