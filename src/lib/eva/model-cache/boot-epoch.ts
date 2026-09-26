export interface BootEpoch {
  current: number;
  lastCleanup: number;
}

const BOOT_DB_NAME = 'kyuby-boot';
const BOOT_STORE_NAME = 'boot';
const BOOT_EPOCH_KEY = 'sw-boot-epoch';
const CLEANUP_EPOCH_KEY = 'last-cleanup-epoch';

function openBootDB(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(BOOT_DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(BOOT_STORE_NAME)) {
          db.createObjectStore(BOOT_STORE_NAME, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function initBootEpoch(): Promise<BootEpoch> {
  const db = await openBootDB();
  if (!db) {
    return { current: 1, lastCleanup: 0 };
  }

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(BOOT_STORE_NAME, 'readwrite');
      const store = tx.objectStore(BOOT_STORE_NAME);
      const getEpochReq = store.get(BOOT_EPOCH_KEY);
      const getCleanupReq = store.get(CLEANUP_EPOCH_KEY);
      let current = 0;
      let lastCleanup = 0;

      getEpochReq.onsuccess = () => {
        const record = getEpochReq.result as { key: string; value: number } | undefined;
        current = typeof record?.value === 'number' ? record.value : 0;
        store.put({ key: BOOT_EPOCH_KEY, value: current + 1 });
      };

      getCleanupReq.onsuccess = () => {
        const record = getCleanupReq.result as { key: string; value: number } | undefined;
        lastCleanup = typeof record?.value === 'number' ? record.value : 0;
      };

      tx.oncomplete = () => {
        db.close();
        resolve({ current: current + 1, lastCleanup });
      };

      tx.onerror = () => {
        db.close();
        resolve({ current: 1, lastCleanup: 0 });
      };
    } catch {
      db.close();
      resolve({ current: 1, lastCleanup: 0 });
    }
  });
}

export async function getBootEpoch(): Promise<BootEpoch> {
  const db = await openBootDB();
  if (!db) {
    return { current: 0, lastCleanup: 0 };
  }

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(BOOT_STORE_NAME, 'readonly');
      const store = tx.objectStore(BOOT_STORE_NAME);
      const getEpochReq = store.get(BOOT_EPOCH_KEY);
      const getCleanupReq = store.get(CLEANUP_EPOCH_KEY);
      let current = 0;
      let lastCleanup = 0;

      getEpochReq.onsuccess = () => {
        const record = getEpochReq.result as { key: string; value: number } | undefined;
        current = typeof record?.value === 'number' ? record.value : 0;
      };

      getCleanupReq.onsuccess = () => {
        const record = getCleanupReq.result as { key: string; value: number } | undefined;
        lastCleanup = typeof record?.value === 'number' ? record.value : 0;
      };

      tx.oncomplete = () => {
        db.close();
        resolve({ current, lastCleanup });
      };

      tx.onerror = () => {
        db.close();
        resolve({ current: 0, lastCleanup: 0 });
      };
    } catch {
      db.close();
      resolve({ current: 0, lastCleanup: 0 });
    }
  });
}

export async function markCleanupComplete(epoch: number): Promise<void> {
  const db = await openBootDB();
  if (!db) {
    return;
  }

  return new Promise((resolve) => {
    try {
      const tx = db.transaction(BOOT_STORE_NAME, 'readwrite');
      const store = tx.objectStore(BOOT_STORE_NAME);
      store.put({ key: CLEANUP_EPOCH_KEY, value: epoch });

      tx.oncomplete = () => {
        db.close();
        resolve();
      };

      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}

export async function resetBootEpochForTesting(): Promise<void> {
  const db = await openBootDB();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(BOOT_STORE_NAME, 'readwrite');
      const store = tx.objectStore(BOOT_STORE_NAME);
      store.clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        resolve();
      };
    } catch {
      db.close();
      resolve();
    }
  });
}
