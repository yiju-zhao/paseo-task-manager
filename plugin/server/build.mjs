import { build } from 'esbuild';
import { createRequire } from 'node:module';

const external = ['@getpaseo/plugin', '@getpaseo/plugin/*', 'zod'];
// A future SDK may remove an internal package export while retaining its public host API. Ship the public collector
// even then: only these two optional imports may resolve to a module that fails lazily inside optionalFileCounter.
const optionalCheckout = {
  name: 'optional-checkout',
  setup(build) {
    build.onResolve({ filter: /^@getpaseo\/client\/internal\/(hosts|daemon-client)$/ }, args => {
      try { createRequire(args.importer).resolve(args.path); }
      catch { return { path: args.path, namespace: 'unavailable-checkout' }; }
    });
    build.onLoad({ filter: /.*/, namespace: 'unavailable-checkout' }, () => ({
      contents: "throw new Error('Optional Paseo checkout module unavailable');",
    }));
  },
};
await build({ entryPoints: ['server/plugin.ts'], bundle: true, format: 'esm', platform: 'node', target: 'node26', external, plugins: [optionalCheckout],
  outfile: 'server/bundle.mjs' });
await build({ entryPoints: ['client/plugin.tsx'], bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic',
  external: [...external, 'react', 'react/jsx-runtime', 'react-native'], outfile: 'client/bundle.mjs' });
