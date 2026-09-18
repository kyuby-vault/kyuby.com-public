import { MODEL_CACHE_MAX_FILES, MODEL_CACHE_MAX_PATH_BYTES } from './types';

export const MODEL_CACHE_PRODUCTION_ORIGIN = 'https://models.kyuby.com';
export const MODEL_CACHE_MANIFEST_FILENAME = 'artifact-manifest.json';

const URL_UNRESERVED_SEGMENT = /^[A-Za-z0-9._~-]+$/;
const SHA256_MANIFEST_VERSION = /^sha256:[a-f0-9]{64}$/;
const STRONG_ETAG_MANIFEST_VERSION = /^"[\x21\x23-\x7e\x80-\xff]*"$/;
const textEncoder = new TextEncoder();

export interface ModelCacheRouteConfigInput {
  appUrl: string;
  modelOrigin: string;
  modelRootPath: string;
  inventoryPaths: readonly string[];
  configuredDevelopmentModelOrigin?: string | null;
}

export interface ModelCacheRouteConfig {
  readonly appOrigin: string;
  readonly modelOrigin: string;
  readonly modelRootPath: string;
  readonly manifestPathname: string;
  readonly inventoryPaths: readonly string[];
}

export interface ModelCacheRequestLike {
  url: string;
  method: string;
  mode: RequestMode;
}

export type ModelCacheRouteBypassReason =
  | 'invalid-url'
  | 'method'
  | 'mode'
  | 'credentials'
  | 'origin'
  | 'query'
  | 'fragment'
  | 'encoded-path'
  | 'path';

export type ModelCacheRoute =
  | {
      kind: 'bypass';
      reason: ModelCacheRouteBypassReason;
    }
  | {
      kind: 'manifest';
      url: string;
      pathname: string;
    }
  | {
      kind: 'artifact';
      url: string;
      pathname: string;
      relativePath: string;
    };

export type ModelCacheFetchDecision =
  | 'bypass'
  | 'handle-manifest'
  | 'serve-verified'
  | 'fetch-and-store'
  | 'network-only';

export interface ModelCacheNetworkResponseLike {
  type: ResponseType;
  redirected: boolean;
  url: string;
}

export type ModelCacheNetworkResponseRejection =
  | 'opaque'
  | 'redirected'
  | 'url-mismatch';

export type ModelCacheNetworkResponseCheck =
  | { ok: true }
  | { ok: false; reason: ModelCacheNetworkResponseRejection };

function utf8Length(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '[::1]'
    || hostname === '::1';
}

function isBareOriginUrl(url: URL): boolean {
  return url.username === ''
    && url.password === ''
    && url.pathname === '/'
    && url.search === ''
    && url.hash === '';
}

function isSafePathSegment(segment: string): boolean {
  return segment !== '.'
    && segment !== '..'
    && URL_UNRESERVED_SEGMENT.test(segment);
}

export function normalizeModelCacheOrigin(value: string): string | null {
  const url = parseHttpUrl(value);
  return url && isBareOriginUrl(url) ? url.origin : null;
}

export function isCanonicalModelId(value: string): boolean {
  if (value.length === 0 || value.includes('\\') || value.includes('%')) {
    return false;
  }
  const segments = value.split('/');
  return segments.every(isSafePathSegment);
}

export function createModelCacheRootPath(modelId: string): string {
  if (!isCanonicalModelId(modelId)) {
    throw new TypeError('Model id must contain only canonical URL-unreserved path segments.');
  }
  return `/${modelId}/`;
}

export function isCanonicalModelCacheRootPath(value: string): boolean {
  return value.startsWith('/')
    && value.endsWith('/')
    && value.length > 2
    && isCanonicalModelId(value.slice(1, -1));
}

export function isCanonicalModelCacheFilePath(value: string): boolean {
  if (value.length === 0
    || value.startsWith('/')
    || value.endsWith('/')
    || value.includes('\\')
    || value.includes('%')
    || value.includes('?')
    || value.includes('#')
    || utf8Length(value) > MODEL_CACHE_MAX_PATH_BYTES) {
    return false;
  }
  return value.split('/').every(isSafePathSegment);
}

export function isAllowedModelCacheOrigin(
  appUrlValue: string,
  requestedModelOriginValue: string,
  configuredDevelopmentModelOriginValue?: string | null,
): boolean {
  const appUrl = parseHttpUrl(appUrlValue);
  const requestedOrigin = normalizeModelCacheOrigin(requestedModelOriginValue);
  if (!appUrl || !requestedOrigin) {
    return false;
  }
  if (requestedOrigin === MODEL_CACHE_PRODUCTION_ORIGIN) {
    return true;
  }
  if (!isLoopbackHostname(appUrl.hostname)) {
    return false;
  }

  const configuredOrigin = configuredDevelopmentModelOriginValue
    ? normalizeModelCacheOrigin(configuredDevelopmentModelOriginValue)
    : null;
  if (!configuredOrigin || configuredOrigin !== requestedOrigin) {
    return false;
  }
  const configuredUrl = new URL(configuredOrigin);
  return configuredUrl.protocol === 'http:' && isLoopbackHostname(configuredUrl.hostname);
}

export function createModelCacheRouteConfig(
  input: ModelCacheRouteConfigInput,
): ModelCacheRouteConfig {
  if (!isAllowedModelCacheOrigin(
    input.appUrl,
    input.modelOrigin,
    input.configuredDevelopmentModelOrigin,
  )) {
    throw new TypeError('Model origin is outside the Eva cache allowlist.');
  }
  const modelOrigin = normalizeModelCacheOrigin(input.modelOrigin);
  if (!modelOrigin || !isCanonicalModelCacheRootPath(input.modelRootPath)) {
    throw new TypeError('Model cache root is not canonical.');
  }
  if (input.inventoryPaths.length > MODEL_CACHE_MAX_FILES) {
    throw new TypeError('Model cache inventory exceeds its file-count limit.');
  }

  const inventoryPaths = input.inventoryPaths.map((path) => {
    if (!isCanonicalModelCacheFilePath(path) || path === MODEL_CACHE_MANIFEST_FILENAME) {
      throw new TypeError(`Invalid model cache inventory path: ${path}`);
    }
    return path;
  });
  if (new Set(inventoryPaths).size !== inventoryPaths.length) {
    throw new TypeError('Model cache inventory contains duplicate paths.');
  }

  const appUrl = new URL(input.appUrl);
  return Object.freeze({
    appOrigin: appUrl.origin,
    modelOrigin,
    modelRootPath: input.modelRootPath,
    manifestPathname: `${input.modelRootPath}${MODEL_CACHE_MANIFEST_FILENAME}`,
    inventoryPaths: Object.freeze(inventoryPaths),
  });
}

export function routeModelCacheRequest(
  request: ModelCacheRequestLike,
  config: ModelCacheRouteConfig,
): ModelCacheRoute {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return { kind: 'bypass', reason: 'method' };
  }
  if (request.mode !== 'cors') {
    return { kind: 'bypass', reason: 'mode' };
  }
  if (request.url.includes('\\')) {
    return { kind: 'bypass', reason: 'encoded-path' };
  }

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return { kind: 'bypass', reason: 'invalid-url' };
  }
  if (url.username !== '' || url.password !== '') {
    return { kind: 'bypass', reason: 'credentials' };
  }
  if (url.origin !== config.modelOrigin) {
    return { kind: 'bypass', reason: 'origin' };
  }
  if (url.search !== '') {
    return { kind: 'bypass', reason: 'query' };
  }
  if (url.hash !== '') {
    return { kind: 'bypass', reason: 'fragment' };
  }
  if (url.pathname.includes('%')) {
    return { kind: 'bypass', reason: 'encoded-path' };
  }
  if (url.pathname === config.manifestPathname) {
    return { kind: 'manifest', url: url.href, pathname: url.pathname };
  }
  if (!url.pathname.startsWith(config.modelRootPath)) {
    return { kind: 'bypass', reason: 'path' };
  }

  const relativePath = url.pathname.slice(config.modelRootPath.length);
  if (!config.inventoryPaths.includes(relativePath)) {
    return { kind: 'bypass', reason: 'path' };
  }
  return {
    kind: 'artifact',
    url: url.href,
    pathname: url.pathname,
    relativePath,
  };
}

export function decideModelCacheFetch(
  route: ModelCacheRoute,
  options: { hasVerifiedEntry: boolean; hasLoadLease: boolean },
): ModelCacheFetchDecision {
  if (route.kind === 'bypass') {
    return 'bypass';
  }
  if (route.kind === 'manifest') {
    return 'handle-manifest';
  }
  if (options.hasVerifiedEntry) {
    return 'serve-verified';
  }
  return options.hasLoadLease ? 'fetch-and-store' : 'network-only';
}

export function checkModelCacheNetworkResponse(
  response: ModelCacheNetworkResponseLike,
  expectedUrl: string,
): ModelCacheNetworkResponseCheck {
  if (response.type === 'opaque'
    || response.type === 'opaqueredirect'
    || response.type === 'error') {
    return { ok: false, reason: 'opaque' };
  }
  if (response.redirected) {
    return { ok: false, reason: 'redirected' };
  }
  let responseUrl: URL;
  let requestedUrl: URL;
  try {
    responseUrl = new URL(response.url);
    requestedUrl = new URL(expectedUrl);
  } catch {
    return { ok: false, reason: 'url-mismatch' };
  }
  return responseUrl.href === requestedUrl.href
    ? { ok: true }
    : { ok: false, reason: 'url-mismatch' };
}

export function createModelCacheKey(
  modelOriginValue: string,
  pathname: string,
  manifestVersion: string,
): string {
  const modelOrigin = normalizeModelCacheOrigin(modelOriginValue);
  if (!modelOrigin
    || !pathname.startsWith('/')
    || pathname.endsWith('/')
    || !pathname.slice(1).split('/').every(isSafePathSegment)
    || !(SHA256_MANIFEST_VERSION.test(manifestVersion)
      || STRONG_ETAG_MANIFEST_VERSION.test(manifestVersion))) {
    throw new TypeError('Cannot create a cache key from non-canonical inputs.');
  }
  return JSON.stringify([modelOrigin, pathname, manifestVersion]);
}
