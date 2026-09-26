import { MINIMUM_STORAGE_HEADROOM } from './resilience';

export type StorageAdmissionState = 'ok' | 'insufficient-storage' | 'cache-unavailable' | 'storage-best-effort';
export type StorageAdmissionCause =
  | 'ok'
  | 'opfs-unavailable'
  | 'quota-null'
  | 'low-quota'
  | 'not-persisted';

export interface StorageAdmissionResult {
  state: StorageAdmissionState;
  code: StorageAdmissionState;
  cause: StorageAdmissionCause;
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
    return { state: 'cache-unavailable', code: 'cache-unavailable', cause: 'opfs-unavailable', message, persisted, opfsAvailable, usage, quota };
  }

  // 2. Capacity / Quota check: block ONLY on quota < requiredBytes (or quota === 0)
  if (quota === 0 || (quota !== null && quota < requiredBytes)) {
    const message = isSafariOrIos()
      ? 'iOS Safari storage limit reached. Free device storage or close other tabs to download the model.'
      : 'Not enough device storage. Free browser storage or remove an old cached model, then retry. Space for the model plus safety headroom is required.';
    const cause = quota === 0 ? 'quota-null' : 'low-quota';
    return { state: 'insufficient-storage', code: 'insufficient-storage', cause, message, persisted, opfsAvailable, usage, quota };
  }

  // 3. Persistence check: persist()=false / best-effort = warn + proceed
  if (!persisted) {
    const message = isAndroidDevice()
      ? 'Android eviction risk: persistent storage was not granted. The browser or operating system may clear cached files under storage pressure.'
      : isSafariOrIos()
        ? 'iOS Safari manages storage automatically. Model files are stored best-effort and may be cleared under storage pressure.'
        : 'Storage is best-effort. The browser or operating system may clear cached files under storage pressure.';
    return { state: 'storage-best-effort', code: 'storage-best-effort', cause: 'not-persisted', message, persisted, opfsAvailable, usage, quota };
  }

  return { state: 'ok', code: 'ok', cause: 'ok', message: '', persisted: true, opfsAvailable: true, usage, quota };
}

export type MemoryAdvisoryKind = 'none' | 'low-device-memory' | 'android-process-limit';

export interface MemoryAdvisory {
  kind: MemoryAdvisoryKind;
  title: string;
  copy: string;
}

export const ANDROID_PACKAGE_RISK_THRESHOLD_BYTES = 2.5 * 1024 * 1024 * 1024; // 2.5 GiB

export function evaluateMemoryAdvisory(
  packageBytes: number = 0,
  deviceMemory: number | undefined = typeof navigator !== 'undefined' ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory : undefined,
  userAgent: string = typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '',
): MemoryAdvisory {
  // UA alone NEVER triggers any memory warning.
  // Low-RAM warning ONLY when navigator.deviceMemory is defined and <= 4.
  if (typeof deviceMemory === 'number' && deviceMemory > 0 && deviceMemory <= 4) {
    return {
      kind: 'low-device-memory',
      title: 'Limited memory warning',
      copy: 'This device has limited memory. Loading this 3GB model may cause the browser tab to crash. Continue anyway?',
    };
  }

  // Separate, accurately-worded notice for THIS package on Android:
  // Sandboxed renderers cap near 2.0-2.4 GB PSS (evidence: ApplicationExitInfo LOW_MEMORY at pss=2.3GB),
  // so a package >= 2.5 GiB can be killed mid-load on ANY Android phone.
  // Wording must state the browser tab/process limit — never "this device has low memory."
  const isAndroid = /Android/i.test(userAgent);
  if (isAndroid && packageBytes >= ANDROID_PACKAGE_RISK_THRESHOLD_BYTES) {
    return {
      kind: 'android-process-limit',
      title: 'Android browser memory limit',
      copy: 'Android limits each browser tab to about 2.2 GB of memory. Loading this large model may cause the browser tab to close or reload. Continue anyway?',
    };
  }

  // Desktop: no memory notice.
  // deviceMemory undefined (iOS/Safari): no memory notice; the storage-admission probe handles those cases separately.
  return {
    kind: 'none',
    title: '',
    copy: '',
  };
}
