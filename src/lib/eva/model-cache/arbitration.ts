import type { ModelCacheLoadLease } from './protocol';

export function sameLeasePackage(a: ModelCacheLoadLease, b: Pick<ModelCacheLoadLease,
  'modelOrigin' | 'modelRootPath' | 'manifestVersion'>): boolean {
  return a.modelOrigin === b.modelOrigin && a.modelRootPath === b.modelRootPath
    && a.manifestVersion === b.manifestVersion;
}

/** SW-only arbitration. Stable insertion order breaks simultaneous creation ties.
 * Removing an owner promotes the oldest attacher without cancelling shared work. */
export function arbitrateModelLeases(leases: Iterable<ModelCacheLoadLease>): void {
  const owners = new Set<string>();
  for (const lease of [...leases].sort((a, b) => a.createdAt - b.createdAt)) {
    const key = JSON.stringify([lease.modelOrigin, lease.modelRootPath, lease.manifestVersion]);
    if (lease.diskOnly) { lease.kind = 'disk'; continue; }
    lease.kind = owners.has(key) ? 'attached' : 'acquiring';
    owners.add(key);
  }
}
