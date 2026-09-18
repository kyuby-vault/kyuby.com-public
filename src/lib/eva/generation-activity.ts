export class GenerationActivity {
  private inFlight = false;

  get active(): boolean { return this.inFlight; }

  async run<Result>(generate: () => Promise<Result>): Promise<Result> {
    if (this.inFlight) throw new Error('A model generation is already in flight.');
    this.inFlight = true;
    try { return await generate(); }
    finally { this.inFlight = false; }
  }
}
