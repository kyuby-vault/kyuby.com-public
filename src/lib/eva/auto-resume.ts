import type { ModelCacheStatus } from './model-cache/types';

export const AUTO_RESUME_STORAGE_KEY = 'kyuby-eva-auto-resume-disk';

export function canAutoResumeFromDisk(enabled: boolean, status: ModelCacheStatus | null): boolean {
  return enabled && status?.residency === 'on-disk' && status.backend === 'opfs'
    && status.integrity === 'verified' && status.cacheAction === 'idle'
    && status.totalBytes !== null && status.totalBytes > 0 && status.cachedBytes === status.totalBytes;
}

export async function autoResumeFromDisk(options: {
  enabled: boolean;
  status: ModelCacheStatus | null;
  verify(): Promise<boolean>;
  loadDisk(): Promise<boolean>;
}): Promise<'skipped' | 'ready' | 'unavailable'> {
  if (!canAutoResumeFromDisk(options.enabled, options.status)) return 'skipped';
  try {
    if (!await options.verify()) return 'unavailable';
    return await options.loadDisk() ? 'ready' : 'unavailable';
  } catch { return 'unavailable'; }
}
