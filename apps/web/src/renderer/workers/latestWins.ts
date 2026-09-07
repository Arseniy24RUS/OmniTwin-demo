export type LatestWinsResult<T> =
  | { status: 'processed'; sequence: number; value: T }
  | { status: 'superseded'; sequence: number };

export interface LatestWinsTelemetry {
  submitted: number;
  executed: number;
  processed: number;
  superseded: number;
  failed: number;
}

interface PendingJob<TInput, TOutput> {
  input: TInput;
  sequence: number;
  resolve: (result: LatestWinsResult<TOutput>) => void;
  reject: (reason: unknown) => void;
}

/**
 * Bounded worker-side queue: the active buffer completes, while at most one
 * pending buffer is retained. Replacing that pending buffer resolves it as
 * superseded instead of allowing unbounded presentation lag.
 */
export class LatestWinsBufferQueue<TInput, TOutput> {
  private sequence = 0;
  private active = false;
  private pending: PendingJob<TInput, TOutput> | null = null;
  private readonly counts: LatestWinsTelemetry = {
    submitted: 0,
    executed: 0,
    processed: 0,
    superseded: 0,
    failed: 0,
  };

  constructor(private readonly process: (input: TInput) => Promise<TOutput> | TOutput) {}

  submit(input: TInput): Promise<LatestWinsResult<TOutput>> {
    const sequence = ++this.sequence;
    this.counts.submitted += 1;
    return new Promise((resolve, reject) => {
      const job: PendingJob<TInput, TOutput> = { input, sequence, resolve, reject };
      if (this.active) {
        if (this.pending) {
          this.counts.superseded += 1;
          this.pending.resolve({ status: 'superseded', sequence: this.pending.sequence });
        }
        this.pending = job;
        return;
      }
      void this.run(job);
    });
  }

  telemetry(): LatestWinsTelemetry {
    return { ...this.counts };
  }

  private async run(job: PendingJob<TInput, TOutput>): Promise<void> {
    this.active = true;
    try {
      const value = await this.process(job.input);
      this.counts.executed += 1;
      if (job.sequence < this.sequence) {
        this.counts.superseded += 1;
        job.resolve({ status: 'superseded', sequence: job.sequence });
      } else {
        this.counts.processed += 1;
        job.resolve({ status: 'processed', sequence: job.sequence, value });
      }
    } catch (error) {
      this.counts.failed += 1;
      job.reject(error);
    } finally {
      const next = this.pending;
      this.pending = null;
      if (next) void this.run(next);
      else this.active = false;
    }
  }
}
