import { KeyConfig } from './types'
import { fileLog } from './logger'

export type ToastFn = (message: string, variant?: 'info' | 'success' | 'error' | 'warning') => Promise<void>

interface KeyState {
  key: string
  name: string           // 尾 4 位
  hits: number[]         // 滑动窗口内时间戳
  cooldownUntil: number
  error429Count: number
  lastSuccessAt: number
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
  windowMs: number          // 滑动窗口长度（ms）。NIM 按 61000（60s + 1s 余量）
  baseCooldownMs: number    // 无 Retry-After 头时的首次冷却毫秒
  maxCooldownMs: number     // 冷却硬上限
  maxConcurrent: number     // 该 provider 同时可发出的最大并发请求数
  strategy: 'round-robin' | 'least-used' | 'random'
  onWait?: (ms: number) => void
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export class ProviderLimiter {
  private keys: KeyState[]
  private rrIndex = 0

  constructor(
    public readonly name: string,
    keyCfgs: KeyConfig[],
    public readonly rpm: number,
    private opts: LimiterOptions
  ) {
    if (keyCfgs.length === 0) throw new Error(`ProviderLimiter ${name}: no keys`)
    this._maxConcurrent = opts.maxConcurrent > 0 ? opts.maxConcurrent : 2
    this.keys = keyCfgs.map(k => ({
      key: k.key, name: k.name ?? k.key.slice(-4),
      hits: [], cooldownUntil: 0, error429Count: 0, lastSuccessAt: 0
    }))
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
            key: k.key, tail: k.name, waitedMs: waited,
            windowUsed: k.hits.length,
            keyIndex: this.keys.indexOf(k), totalKeys: this.keys.length
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
    throw new Error(`[poorguy-ratelimit] ${this.name}: acquire failed after 120 rounds`)
  }

  /** NIM 429 处理：优先用 Retry-After 头，否则指数退避（封顶 maxCooldownMs） */
  mark429(tail: string, responseHeaders?: Headers): number {
    const k = this.keys.find(x => x.name === tail)
    if (!k) return 0

    const now = Date.now()
    const ram = responseHeaders?.get('retry-after-ms')
    const ra = responseHeaders?.get('retry-after')
    const fromHeader = ram ? parseFloat(ram) : ra ? parseFloat(ra) * 1000 : undefined

    const cooldownMs = Number.isFinite(fromHeader)
      ? Math.min(fromHeader!, this.opts.maxCooldownMs)
      : Math.min(this.opts.baseCooldownMs * Math.pow(2, k.error429Count), this.opts.maxCooldownMs)

    k.error429Count++
    k.cooldownUntil = now + cooldownMs
    fileLog('warn', `[${this.name}] 429 @key…${k.name} -> cooldown ${cooldownMs}ms (本 key 连败 ${k.error429Count})`)
    return cooldownMs
  }

  /** 请求成功 → 清零错误计数，熔断恢复 */
  noteSuccess(tail: string): void {
    const k = this.keys.find(x => x.name === tail)
    if (k) { k.error429Count = 0; k.lastSuccessAt = Date.now() }
  }

  remaining(now = Date.now()): number {
    let r = 0
    for (const k of this.keys) {
      this.evict(k, now)
      if (k.cooldownUntil <= now) r += this.rpm - k.hits.length
    }
    return r
  }

  /** 当前没有冷却压制的 key 数 */
  availableKeyCount(now = Date.now()): number {
    return this.keys.filter(k => k.cooldownUntil <= now).length
  }

  get totalKeyCount(): number { return this.keys.length }

  // —— 并发闸门 ——
  setMaxConcurrent(n: number) { this._maxConcurrent = n }
  private _maxConcurrent: number
  private inFlight = 0
  private queue: (() => void)[] = []

  /** 抢到并发位才算真的放行；超额则排队等待前面的请求完成 */
  async acquireSlot(): Promise<void> {
    if (this.inFlight < this._maxConcurrent) {
      this.inFlight++
      return
    }
    fileLog('info', `[${this.name}] 并发位已满 (${this.inFlight}/${this._maxConcurrent})，排队等待`)
    await new Promise<void>(r => this.queue.push(r))
    this.inFlight++
  }

  releaseSlot(): void {
    this.inFlight--
    const next = this.queue.shift()
    if (next) next()
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
      case 'random': {
        for (let i = avail.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [avail[i], avail[j]] = [avail[j], avail[i]]
        }
        return avail
      }
      default: return avail
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
    return Number.isFinite(wait) ? Math.max(10, wait + 10) : 1000
  }
}

/** 包一层 fetch：限流→轮换 Authorization→429 时本地轮询换 key 重试（不交给 opencode） */
export function wrapFetch(
  origFetch: typeof globalThis.fetch,
  limiter: ProviderLimiter,
  toast: ToastFn
): typeof globalThis.fetch {
  const wrapped: typeof globalThis.fetch = async (input: any, init?: any) => {
    const maxAttempts = limiter.totalKeyCount  // 每把 key 试一次，全部失败才还给 opencode
    let lastRes: Response | undefined

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const acq = await limiter.acquire()        // 窗口额度
      await limiter.acquireSlot()                // 并发位

      await toast(`🔑 [${limiter.name}] key…${acq.tail} · 窗口 ${acq.windowUsed}/${limiter.rpm} · key ${acq.keyIndex + 1}/${acq.totalKeys}`, 'info')

      const headers = new Headers(init?.headers)
      headers.set('Authorization', `Bearer ${acq.key}`)
      const finalInit = { ...(init ?? {}), headers }

      let res: Response
      try {
        res = await origFetch(input, finalInit)
      } catch (e) {
        limiter.releaseSlot()
        throw e
      }
      fileLog('info', `[${limiter.name}] key=…${acq.tail} wait=${acq.waitedMs}ms attempt=${attempt + 1}/${maxAttempts} -> ${res.status}`)

      if (res.status === 429) {
        limiter.releaseSlot()
        const cd = limiter.mark429(acq.tail, res.headers)
        lastRes = res
        await toast(`🚫 [${limiter.name}] key…${acq.tail} 429，冷却 ${(cd / 1000).toFixed(0)}s${attempt < maxAttempts - 1 ? '，换下一把' : '，key 用尽交 opencode 重试'}`, 'error')
        continue
      }

      // 非 429：成功的请求在流读完/关闭前一直占用并发位
      limiter.noteSuccess(acq.tail)
      if (attempt > 0) {
        await toast(`✅ [${limiter.name}] key…${acq.tail} 第 ${attempt + 1} 次成功`, 'success')
      }
      return wrapResponseForSlot(res, () => limiter.releaseSlot(), init?.signal)
    }

    // 所有 key 都 429，把最后的 429 响应还回去，让 opencode 自己的重试来扛
    return lastRes!
  }
  return wrapped
}

/** 流式响应期间保持并发位不释放；读尽/关闭/请求被 abort 时归还 */
function wrapResponseForSlot(res: Response, release: () => void, signal?: AbortSignal | null): Response {
  if (!res.body) {
    release()
    return res
  }
  const { readable, writable } = new TransformStream()
  const reader = res.body.getReader()
  const writer = writable.getWriter()
  // 调用方中断请求（如用户在 opencode 里打断生成）→ 立刻取消底层 reader，
  // 否则泵循环悬挂在 read() 上，并发槽永远不释放
  // 注意：泵循环可能卡在 writer.write()（没人消费 body 时 HWM 背压），
  // 只 cancel reader 解不开这个 await，必须同时 abort writer 让挂起的 write 立即 reject
  const onAbort = () => {
    reader.cancel().catch(() => {})
    writer.abort(new Error('request aborted')).catch(() => {})
  }
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  ;(async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        await writer.write(value)
      }
      await writer.close()
    } catch (e) {
      try { writer.abort(e) } catch {}
    } finally {
      signal?.removeEventListener('abort', onAbort)
      release()
    }
  })()
  return new Response(readable, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers
  })
}
