/** A screen wake lock is an explicit-lease convenience, never a durability guarantee. */
export class AcquisitionWakeLock {
  #active = false;
  #generation = 0;
  #sentinel: WakeLockSentinel | null = null;
  #pending = false;
  constructor(readonly unavailable: () => void, readonly nav = navigator, readonly doc = document) {}

  async start(): Promise<void> {
    this.#active = true;
    this.doc.addEventListener('visibilitychange', this.#visible);
    await this.#request();
  }

  stop(): void {
    this.#active = false;
    this.#generation++;
    this.doc.removeEventListener('visibilitychange', this.#visible);
    const sentinel = this.#sentinel;
    this.#sentinel = null;
    void sentinel?.release().catch(() => undefined);
  }

  #visible = (): void => { if (this.doc.visibilityState === 'visible') void this.#request(); };

  async #request(): Promise<void> {
    if (!this.#active || this.#pending || this.doc.visibilityState !== 'visible' || this.#sentinel && !this.#sentinel.released) return;
    if (!this.nav.wakeLock?.request) { this.unavailable(); return; }
    const generation = this.#generation;
    this.#pending = true;
    try {
      const sentinel = await this.nav.wakeLock.request('screen');
      if (!this.#active || generation !== this.#generation) { await sentinel.release(); return; }
      this.#sentinel = sentinel;
      sentinel.addEventListener('release', () => { if (this.#sentinel === sentinel) this.#sentinel = null; }, { once: true });
    } catch { if (this.#active) this.unavailable(); }
    finally {
      this.#pending = false;
      if (this.#active && generation !== this.#generation) void this.#request();
    }
  }
}
