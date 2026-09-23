/** A screen wake lock is an explicit-lease convenience, never a durability guarantee. */
export class AcquisitionWakeLock {
  #active = false;
  #generation = 0;
  #sentinel: WakeLockSentinel | null = null;
  #pending = false;
  constructor(readonly unavailable: () => void, readonly nav = navigator, readonly doc = document,
    readonly observe: (code: string) => void = () => {}) {}

  get state(): { active: boolean; held: boolean; pending: boolean } {
    return { active: this.#active, held: Boolean(this.#sentinel && !this.#sentinel.released), pending: this.#pending };
  }
  #report(code: string): void { try { this.observe(code); } catch { /* Diagnostics must not affect acquisition. */ } }

  async start(): Promise<void> {
    this.#report('start');
    this.#active = true;
    this.doc.addEventListener('visibilitychange', this.#visible);
    await this.#request();
  }

  stop(): void {
    if (this.#active || this.#sentinel) this.#report('stop');
    this.#active = false;
    this.#generation++;
    this.doc.removeEventListener('visibilitychange', this.#visible);
    const sentinel = this.#sentinel;
    this.#sentinel = null;
    void sentinel?.release().catch(() => undefined);
  }

  #visible = (): void => {
    this.#report(this.doc.visibilityState === 'visible' ? 'visible' : 'hidden');
    if (this.doc.visibilityState === 'visible') void this.#request();
  };

  async #request(): Promise<void> {
    if (!this.#active || this.#pending || this.doc.visibilityState !== 'visible' || this.#sentinel && !this.#sentinel.released) return;
    if (!this.nav.wakeLock?.request) { this.#report('unsupported'); this.unavailable(); return; }
    const generation = this.#generation;
    this.#pending = true;
    this.#report('request');
    try {
      const sentinel = await this.nav.wakeLock.request('screen');
      if (!this.#active || generation !== this.#generation) { await sentinel.release(); this.#report('late-grant-released'); return; }
      this.#sentinel = sentinel;
      this.#report('acquired');
      sentinel.addEventListener('release', () => {
        this.#report('released');
        if (this.#sentinel === sentinel) this.#sentinel = null;
      }, { once: true });
    } catch { this.#report('denied'); if (this.#active) this.unavailable(); }
    finally {
      this.#pending = false;
      if (this.#active && generation !== this.#generation) void this.#request();
    }
  }
}
