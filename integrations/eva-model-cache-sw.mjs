import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';

const SERVICE_WORKER_PATH = '/eva-model-cache-sw.js';
const serviceWorkerEntry = fileURLToPath(
  new URL('../src/workers/eva-model-cache.sw.ts', import.meta.url),
);

function createBuildOptions(development) {
  const configuredDevelopmentOrigin = process.env.PUBLIC_EVA_MODEL_HOST?.trim() ?? '';
  return {
    entryPoints: [serviceWorkerEntry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    charset: 'utf8',
    legalComments: 'none',
    logLevel: 'silent',
    treeShaking: true,
    minifySyntax: !development,
    define: {
      __EVA_CONFIGURED_DEVELOPMENT_MODEL_ORIGIN__: JSON.stringify(configuredDevelopmentOrigin),
      __EVA_MODEL_CACHE_DEV__: JSON.stringify(development),
    },
  };
}

export default function evaModelCacheServiceWorker() {
  let developmentContext;

  return {
    name: 'eva-model-cache-service-worker',
    hooks: {
      'astro:server:setup': async ({ server }) => {
        developmentContext = await context({
          ...createBuildOptions(true),
          outfile: 'eva-model-cache-sw.js',
          sourcemap: 'inline',
          write: false,
        });

        server.middlewares.use(async (request, response, next) => {
          const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
          if (pathname !== SERVICE_WORKER_PATH || (request.method !== 'GET' && request.method !== 'HEAD')) {
            next();
            return;
          }

          try {
            const result = await developmentContext.rebuild();
            const output = result.outputFiles?.find((file) => file.path.endsWith('.js'));
            if (!output) {
              throw new Error('The Eva model-cache Service Worker bundle was not emitted.');
            }

            response.statusCode = 200;
            response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
            response.setHeader('Cache-Control', 'no-cache');
            response.setHeader('Content-Length', String(output.contents.byteLength));
            response.end(request.method === 'HEAD' ? undefined : output.contents);
          } catch (error) {
            server.config.logger.error(
              `Failed to build ${SERVICE_WORKER_PATH}: ${error instanceof Error ? error.message : String(error)}`,
            );
            response.statusCode = 500;
            response.setHeader('Content-Type', 'text/plain; charset=utf-8');
            response.setHeader('Cache-Control', 'no-store');
            response.end('Eva model-cache Service Worker build failed.');
          }
        });

        server.httpServer?.once('close', () => {
          void developmentContext?.dispose();
          developmentContext = undefined;
        });
      },

      'astro:build:done': async ({ dir }) => {
        await build({
          ...createBuildOptions(false),
          outfile: fileURLToPath(new URL(`.${SERVICE_WORKER_PATH}`, dir)),
          sourcemap: false,
          write: true,
        });
      },
    },
  };
}
