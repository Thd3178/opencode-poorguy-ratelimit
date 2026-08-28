import { KeyConfig, BackoffConfig } from './types'
import { ExponentialBackoff } from './exponential-backoff'
import { fileLog } from './logger'

export type ToastFn = (message: string, variant?: 'info' | 'success' | 'error' | 'warning') => Promise<void>

interface KeyState {
  key: string
  name: string           // 尾 4 位
  hits: number[]         // 窗口内请求时间戳（滑动窗口）
  cooldownUntil: number  // 429 冷却截止
  error429Count: number
}

export interface Acquired {
  key: string
  tail: string
  waitedMs: number
  windowUsed: number
  keyIndex: number
  totalKeys: number
}

interface LimiterOptions {
  windowMs: number
  backoff: BackoffConfig
  strategy: 'round-robin' | 'least-used' | 'random'
  onWait?: (ms: number) => void   // 开始阻塞前回调（toast 通知时机）
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export class ProviderLimiter {
  private keys: KeyState[]
  private rrIndex = 0
  private backoff: ExponentialBackoff

  constructor(
    public readonly name: string,
    keyCfgs: KeyConfig[],
    public readonly rpm: number,
    private opts: LimiterOptions
  ) {
    if (keyCfgs.length === 0) throw new Error(`ProviderLimiter ${name}: no keys`)
    this.keys = keyCfgs.map(k => ({
      key: k.key,
      name: k.name ?? k.key.slice(-4),
      hits: [],
      cooldownUntil: 0,
      error429Count: 0
    }))
    this.backoff = new ExponentialBackoff(
      opts.backoff.maxRetries,
      opts.backoff.baseDelayMs,
      opts.backoff.maxDelayMs,
      opts.backoff.jitterFactor
    )
  }

  async acquire(): Promise<Acquired> {
    let waited = 0
    for (let round = 0; round < 120; round++) {
      const now = Date.now()
      for (const k of this.orderedAvailable(now)) {
        this.evict(k, now)
        if (k.hits.length < this.rpm) {
          k.hits.push(now)
          this.rrIndex = (this.keys.indexOf(k) + 1) % this.keys.length
          return {
            key: k.key,
            tail: k.name,
            waitedMs: waited,
            windowUsed: k.hits.length,
            keyIndex: this.keys.indexOf(k),
            totalKeys: this.keys.length
          }
        }
      }
      const wait = this.earliestAvailable(now)
      if (wait > 0) {
        this.opts.onWait?.(wait + waited)
        await sleep(wait)
        waited += wait
      }
    }
    throw new Error(`[poorguy-ratelimit] provider ${this.name}: acquire不断失败`)
  }

  /** 收到 429 响应时调用：冷却该 key，返回冷却毫秒 */
  mark429(tail: string): number {
    const k = this.keys.find(x => x.name === tail)
    if (!k) return 0
    k.error429Count++
    const ms = this.backoff.calculateDelay(k.error429Count)
    k.cooldownUntil = Date.now() + ms
    fileLog('warn', `[${this.name}] 429 @key…${k.name} -> cooldown ${ms}ms (第${k.error429Count}次)`)
    return ms
  }

  /** 窗口内剩余容量合计（用于展示/诊断） */
  remaining(now = Date.now()): number {
    let r = 0
    for (const k of this.keys) {
      this.evict(k, now)
      if (k.cooldownUntil <= now) r += this.rpm - k.hits.length
    }
    return r
  }

  private orderedAvailable(now: number): KeyState[] {
    const avail = this.keys.filter(k => k.cooldownUntil <= now)
    if (avail.length === 0) return []
    const n = this.keys.length
    switch (this.opts.strategy) {
      case 'round-robin': {
        const out: KeyState[] = []
        for (let i = 0; i < n; i++) {
          const k = this.keys[(this.rrIndex + i) % n]
          if (k.cooldownUntil <= now) out.push(k)
        }
        return out
      }
      case 'least-used': {
        for (const k of avail) this.evict(k, now)
        return [...avail].sort((a, b) => a.hits.length - b.hits.length)
      }
      case 'random':
        for (let i = avail.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [avail[i], avail[j]] = [avail[j], avail[i]]
        }
        return avail
      default:
        return avail
    }
  }

  private evict(k: KeyState, now: number): void {
    const cutoff = now - this.opts.windowMs
    while (k.hits.length > 0 && k.hits[0] <= cutoff) k.hits.shift()
  }

  private earliestAvailable(now: number): number {
    let wait = Infinity
    for (const k of this.keys) {
      if (k.cooldownUntil > now) { wait = Math.min(wait, k.cooldownUntil - now); continue }
      this.evict(k, now)
      if (k.hits.length >= this.rpm) wait = Math.min(wait, k.hits[0] + this.opts.windowMs - now)
    }
    return Number.isFinite(wait) ? Math.max(5, wait + 5) : 1000
  }
}

/** 包一层 fetch：限流 → 轮换 Authorization → 侦测 429 */
export function wrapFetch(
  origFetch: typeof globalThis.fetch,
  limiter: ProviderLimiter,
  toast: ToastFn,
  verboseLog: boolean
): typeof globalThis.fetch {
  const wrapped: typeof globalThis.fetch = async (input: any, init?: any) => {
    const acq = await limiter.acquire()
    if (acq.waitedMs > 0) {
      await toast(
        `⏳ [${limiter.name}] 等待 ${(acq.waitedMs / 1000).toFixed(1)}s（${limiter.rpm} req/min × ${acq.totalKeys} key）`,
        'warning'
      )
    }
    await toast(
      `🔑 [${limiter.name}] key…${acq.tail} · 窗口 ${acq.windowUsed}/${limiter.rpm} · key ${acq.keyIndex + 1}/${acq.totalKeys}`,
      'info'
    )

    // 轮换 Authorization 头
    const headers = new Headers(init?.headers)
    headers.set('Authorization', `Bearer ${acq.key}`)
    const finalInit = { ...(init ?? {}), headers }

    const res = await origFetch(input, finalInit)
    fileLog('info', `[${limiter.name}] key=…${acq.tail} wait=${acq.waitedMs}ms -> ${res.status}`)

    if (res.status === 429) {
      const cd = limiter.mark429(acq.tail)
      await toast(
        `🚫 [${limiter.name}] key …${acq.tail} 被 429，冷却 ${(cd / 1000).toFixed(0)}s${acq.totalKeys > 1 ? '，切到下一把 key' : ''}`,
        'error'
      )
    }
    return res
  }
  return wrapped
}
