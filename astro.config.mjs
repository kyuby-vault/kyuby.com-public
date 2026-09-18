import { defineConfig } from 'astro/config';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import evaModelCacheServiceWorker from './integrations/eva-model-cache-sw.mjs';

// memfs imports node: built-ins explicitly. Polyfill both dev dependencies and
// production Workers, without granting fs/network access or changing inference code.
const sandboxPolyfills = () => nodePolyfills({
  include: ['buffer', 'events', 'path', 'stream', 'url'],
  globals: { Buffer: true, global: true, process: true },
  protocolImports: true,
}).flat(Infinity).map((plugin) => {
  if (plugin.name !== 'vite-plugin-node-polyfills') return plugin;
  return {
    ...plugin,
    config(...args) {
      const config = plugin.config.call(this, ...args);
      // Match built-ins exactly. A prefix alias for stream would also rewrite
      // PGlite's Node-only stream/promises import into a nonexistent browser file.
      config.resolve.alias = Object.entries(config.resolve.alias).map(([name, replacement]) => ({
        find: new RegExp(`^${name}$`), replacement,
      }));
      return config;
    },
  };
});

// https://astro.build/config
export default defineConfig({
  site: 'https://kyuby.com',
  integrations: [evaModelCacheServiceWorker()],
  vite: {
    plugins: [sandboxPolyfills()],
    worker: { plugins: () => [sandboxPolyfills()] },
    optimizeDeps: {
      // Prebundle stream too: PGlite's late Node-only import would otherwise
      // discover the polyfill mid-conversation and force a dev-server page reload.
      include: ['@huggingface/transformers', 'memfs', 'stream'],
      exclude: ['@electric-sql/pglite'],
    },
  },
  devToolbar: {
    enabled: false,
  },
});
