export const EVA_RECOVERY_INTERVAL_MS = 5 * 60 * 1000;

/** Serializes dirty snapshots; no model work, unload writes, or IPC. */
export class RecoveryCheckpoint<T> {
  #revision = 0;
  #savedRevision = 0;
  #pending: Promise<void> | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly snapshot: () => T,
    private readonly write: (snapshot: T) => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  markDirty(): void { this.#revision += 1; }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      void this.flush().catch(this.onError);
    }, EVA_RECOVERY_INTERVAL_MS);
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  async reset(): Promise<void> {
    this.stop();
    while (this.#pending) await this.#pending.catch(() => undefined);
    this.#savedRevision = this.#revision;
  }

  async flush(): Promise<void> {
    while (this.#pending) await this.#pending;
    if (this.#savedRevision === this.#revision) return;
    const revision = this.#revision;
    const snapshot = this.snapshot();
    const pending = this.write(snapshot).then(() => {
      this.#savedRevision = revision;
    });
    this.#pending = pending;
    try {
      await pending;
    } finally {
      if (this.#pending === pending) this.#pending = null;
    }
  }
}
