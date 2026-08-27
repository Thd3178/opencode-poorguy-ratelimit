export class TokenBucket {
  private tokens: number
  private lastRefill: number

  constructor(
    private capacity: number,
    private refillRate: number,
    initialTokens?: number
  ) {
    this.tokens = initialTokens ?? capacity
    this.lastRefill = Date.now()
  }

  tryConsume(count: number = 1): boolean {
    this.refill()
    if (this.tokens >= count) {
      this.tokens -= count
      return true
    }
    return false
  }

  getWaitTime(count: number = 1): number {
    this.refill()
    if (this.tokens >= count) return 0
    const deficit = count - this.tokens
    return Math.ceil((deficit / this.refillRate) * 1000)
  }

  getTokens(): number {
    this.refill()
    return this.tokens
  }

  private refill(): void {
    const now = Date.now()
    const elapsed = (now - this.lastRefill) / 1000
    const tokensToAdd = elapsed * this.refillRate
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd)
    this.lastRefill = now
  }
}
