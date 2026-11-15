import { alertSummary } from "../errors.js";
export class Alerts {
  private last = -Infinity;
  private suppressed = 0;
  constructor(
    private readonly clock: () => Date,
    private readonly send: (text: string) => Promise<unknown>,
  ) {}
  async report(error: unknown): Promise<void> {
    const now = +this.clock();
    if (now - this.last < 60000) {
      this.suppressed++;
      return;
    }
    this.last = now;
    const suppressed = this.suppressed;
    this.suppressed = 0;
    try {
      await this.send(
        `R9K error: ${alertSummary(error)}; suppressed since last alert: ${suppressed}.`,
      );
    } catch {
      this.suppressed += suppressed + 1;
    }
  }
}
