import { Stats } from './types'

export class StatsCollector {
  private stats: Stats
  private startTime: number

  constructor() {
    this.startTime = Date.now()
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      rateLimitedRequests: 0,
      errors429: 0,
      totalWaitTime: 0,
      byProvider: {},
      byKey: {}
    }
  }

  recordRequest(provider: string, key: string): void {
    this.stats.totalRequests++
    this.stats.successfulRequests++

    if (!this.stats.byProvider[provider]) {
      this.stats.byProvider[provider] = { requests: 0, errors429: 0, waitTime: 0 }
    }
    this.stats.byProvider[provider].requests++

    const keyId = `${provider}:${key}`
    if (!this.stats.byKey[keyId]) {
      this.stats.byKey[keyId] = { requests: 0, errors429: 0, lastUsed: 0 }
    }
    this.stats.byKey[keyId].requests++
    this.stats.byKey[keyId].lastUsed = Date.now()
  }

  recordRateLimit(provider: string, waitTime: number): void {
    this.stats.rateLimitedRequests++
    this.stats.totalWaitTime += waitTime

    if (this.stats.byProvider[provider]) {
      this.stats.byProvider[provider].waitTime += waitTime
    }
  }

  record429(provider: string, key: string): void {
    this.stats.errors429++

    if (this.stats.byProvider[provider]) {
      this.stats.byProvider[provider].errors429++
    }

    const keyId = `${provider}:${key}`
    if (!this.stats.byKey[keyId]) {
      this.stats.byKey[keyId] = { requests: 0, errors429: 0, lastUsed: 0 }
    }
    this.stats.byKey[keyId].errors429++
  }

  getStats(): Stats {
    return { ...this.stats }
  }

  getSummary(): string {
    const uptime = Math.floor((Date.now() - this.startTime) / 1000)
    const lines = [
      `=== Poorguy Ratelimit Stats ===`,
      `Uptime: ${uptime}s`,
      `Total Requests: ${this.stats.totalRequests}`,
      `Successful: ${this.stats.successfulRequests}`,
      `Rate Limited: ${this.stats.rateLimitedRequests}`,
      `429 Errors: ${this.stats.errors429}`,
      `Total Wait Time: ${this.stats.totalWaitTime}ms`,
      ``,
      `--- By Provider ---`
    ]

    for (const [provider, data] of Object.entries(this.stats.byProvider)) {
      lines.push(`${provider}: ${data.requests} requests, ${data.errors429} 429s, ${data.waitTime}ms wait`)
    }

    lines.push(``, `--- By Key ---`)
    for (const [keyId, data] of Object.entries(this.stats.byKey)) {
      lines.push(`${keyId}: ${data.requests} requests, ${data.errors429} 429s`)
    }

    return lines.join('\n')
  }

  reset(): void {
    this.startTime = Date.now()
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      rateLimitedRequests: 0,
      errors429: 0,
      totalWaitTime: 0,
      byProvider: {},
      byKey: {}
    }
  }
}
