const t0 = Date.now();

function stamp(): string {
  const s = Math.round((Date.now() - t0) / 1000);
  const m = Math.floor(s / 60);
  return `[${String(m).padStart(3, " ")}m${String(s % 60).padStart(2, "0")}s]`;
}

export function log(msg: string): void {
  const mem = process.memoryUsage().rss / 1024 / 1024;
  process.stdout.write(`${stamp()} ${msg}  (rss ${Math.round(mem)} MB)\n`);
}

export function warn(msg: string): void {
  process.stdout.write(`${stamp()} WARN ${msg}\n`);
}

export type Logger = (msg: string) => void;

/** Collects stage durations for the build report. */
export class StageTimer {
  readonly durations: Record<string, number> = {};
  private cur: { name: string; start: number } | null = null;

  start(name: string): void {
    this.end();
    this.cur = { name, start: Date.now() };
    log(`=== stage: ${name}`);
  }

  end(): void {
    if (this.cur) {
      const sec = (Date.now() - this.cur.start) / 1000;
      this.durations[this.cur.name] = (this.durations[this.cur.name] ?? 0) + Math.round(sec * 10) / 10;
      log(`=== done: ${this.cur.name} in ${sec.toFixed(1)}s`);
      this.cur = null;
    }
  }
}
