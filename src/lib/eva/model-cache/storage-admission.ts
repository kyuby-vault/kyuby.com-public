import { MINIMUM_STORAGE_HEADROOM } from './resilience';

export type StorageAdmissionState = 'ok' | 'insufficient-storage' | 'cache-unavailable' | 'storage-best-effort';

export interface StorageAdmissionResult {
  state: StorageAdmissionState;
  code: StorageAdmissionState;
  message: string;
  persisted: boolean;
  opfsAvailable: boolean;
  usage: number | null;
  quota: number | null;
}

export function isSafariOrIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const vendor = navigator.vendor || '';
  return /iPad|iPhone|iPod/.test(ua) || (vendor.includes('Apple') && /Safari/.test(ua) && !/Chrome|CriOS/.test(ua));
}

export function isAndroidDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android/i.test(navigator.userAgent || '');
}

export async function testOpfsAvailability(): Promise<boolean> {
  if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
    return false;
  }
  try {
    const root = await navigator.storage.getDirectory();
    const probe = `.probe-${crypto.randomUUID()}`;
    const handle = await root.getFileHandle(probe, { create: true });
    await root.removeEntry(probe).catch(() => undefined);
    return Boolean(handle);
  } catch {
    return false;
  }
}

export async function probeStorageAdmission(
  requiredBytes: number = 0,
  cachedBytes: number = 0,
): Promise<StorageAdmissionResult> {
  const opfsAvailable = await testOpfsAvailability();
  let usage: number | null = null;
  let quota: number | null = null;
  let persisted = false;

  if (typeof navigator !== 'undefined' && navigator.storage) {
    if (typeof navigator.storage.persisted === 'function') {
      try { persisted = await navigator.storage.persisted(); } catch { persisted = false; }
    }
    if (typeof navigator.storage.estimate === 'function') {
      try {
        const est = await navigator.storage.estimate();
        usage = typeof est.usage === 'number' ? est.usage : null;
        quota = typeof est.quota === 'number' ? est.quota : null;
      } catch {
        // Leave as null
      }
    }
  }

  // 1. OPFS check (e.g. Safari Private Browsing)
  if (!opfsAvailable) {
    const message = isSafariOrIos()
      ? 'Safari storage limit reached or Private Browsing detected. Please disable Private Browsing or allow persistent storage to download the model.'
      : 'Local cache unavailable. A large model requires working browser storage. Your conversation is unchanged; enable site storage and retry.';
    return { state: 'cache-unavailable', code: 'cache-unavailable', message, persisted, opfsAvailable, usage, quota };
  }

  // 2. Capacity / Quota check
  const remaining = Math.max(0, requiredBytes - cachedBytes);
  const available = (quota !== null && usage !== null) ? Math.max(0, quota - usage) : null;
  const headroom = Math.max(Math.ceil(requiredBytes * 0.1), MINIMUM_STORAGE_HEADROOM);

  if (quota === 0 || (available !== null && remaining > 0 && available < remaining + headroom)) {
    const message = isSafariOrIos()
      ? 'Safari storage limit reached or Private Browsing detected. Please disable Private Browsing or allow persistent storage to download the model.'
      : 'Not enough device storage. Free browser storage or remove an old cached model, then retry. Space for the model plus safety headroom is required.';
    return { state: 'insufficient-storage', code: 'insufficient-storage', message, persisted, opfsAvailable, usage, quota };
  }

  // 3. Persistence check
  if (!persisted) {
    const message = isAndroidDevice()
      ? 'Android eviction risk: persistent storage was not granted. The browser or operating system may clear cached files under storage pressure.'
      : 'Storage is best-effort. The browser or operating system may clear cached files under storage pressure.';
    return { state: 'storage-best-effort', code: 'storage-best-effort', message, persisted, opfsAvailable, usage, quota };
  }

  return { state: 'ok', code: 'ok', message: '', persisted: true, opfsAvailable: true, usage, quota };
}
