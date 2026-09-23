import { defineConfig } from 'astro/config';
import { createRequire } from 'node:module';
import inject from '@rollup/plugin-inject';
import evaModelCacheServiceWorker from './integrations/eva-model-cache-sw.mjs';

const require = createRequire(import.meta.url);

const polyfillMap = {
  'buffer': require.resolve('buffer/'),
  'node:buffer': require.resolve('buffer/'),
  'path': require.resolve('path-browserify'),
  'node:path': require.resolve('path-browserify'),
  'events': require.resolve('events/'),
  'node:events': require.resolve('events/'),
  'stream': require.resolve('stream-browserify'),
  'node:stream': require.resolve('stream-browserify'),
  'url': require.resolve('url/'),
  'node:url': require.resolve('url/'),
  'process': require.resolve('process/browser.js'),
  'node:process': require.resolve('process/browser.js'),
};

const rolldownNodePolyfills = () => ({
  name: 'rolldown-node-polyfills',
  resolveId(id) {
    if (id in polyfillMap) return polyfillMap[id];
    return null;
  },
});

const clientNodePolyfills = () => ({
  name: 'client-node-polyfills',
  enforce: 'pre',
  resolveId(id, _importer, options) {
    const isServer = Boolean(options?.ssr || (this.environment && this.environment.name !== 'client'));
    if (!isServer && id in polyfillMap) {
      return polyfillMap[id];
    }
    return null;
  },
});

// https://astro.build/config
export default defineConfig({
  site: 'https://kyuby.com',
  integrations: [evaModelCacheServiceWorker()],
  vite: {
    plugins: [clientNodePolyfills()],
    worker: {
      plugins: () => [
        clientNodePolyfills(),
        inject({
          Buffer: ['buffer', 'Buffer'],
          process: 'process',
        }),
      ],
    },
    optimizeDeps: {
      include: ['@huggingface/transformers', 'memfs'],
      exclude: ['@electric-sql/pglite'],
      rolldownOptions: {
        plugins: [rolldownNodePolyfills()],
      },
    },
  },
  devToolbar: {
    enabled: false,
  },
});
