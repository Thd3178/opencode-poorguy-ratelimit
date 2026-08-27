export class ExponentialBackoff {
  constructor(
    private maxRetries: number,
    private baseDelayMs: number,
    private maxDelayMs: number,
    private jitterFactor: number
  ) {}

  calculateDelay(attempt: number): number {
    const exponential = Math.min(
      this.baseDelayMs * Math.pow(2, attempt),
      this.maxDelayMs
    )
    const jitter = exponential * this.jitterFactor * (Math.random() * 2 - 1)
    return Math.max(0, Math.round(exponential + jitter))
  }

  async wait(attempt: number): Promise<void> {
    const delay = this.calculateDelay(attempt)
    await new Promise(resolve => setTimeout(resolve, delay))
    return
  }

  getMaxRetries(): number {
    return this.maxRetries
  }
}
