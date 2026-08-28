import { ProviderLimiter } from './fetch-interceptor'
import { BackoffConfig } from './types'

const mkOpts = (strategy: 'round-robin' | 'least-used' | 'random', windowMs: number) => ({
  windowMs, baseCooldownMs: 100, maxCooldownMs: 1000, strategy,
})

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`FAIL: ${msg}`); process.exitCode = 1 }
  else console.log(`ok: ${msg}`)
}

async function testRoundRobin() {
  const lim = new ProviderLimiter('t', [{ key: 'AAAAAAAAAAAA1111' }, { key: 'BBBBBBBBBBBB2222' }], 100, mkOpts('round-robin', 60000))
  const a1 = await lim.acquire()
  const a2 = await lim.acquire()
  const a3 = await lim.acquire()
  assert(a1.tail !== a2.tail, `round-robin: 交替取 key（${a1.tail} -> ${a2.tail}）`)
  assert(a3.tail === a1.tail, `round-robin: 第三次回到第一把（${a3.tail}）`)
}

async function testWindowThrottle() {
  const lim = new ProviderLimiter('t', [{ key: 'AAAAAAAAAAAA1111' }], 2, mkOpts('round-robin', 300))
  const t0 = Date.now()
  await lim.acquire(); await lim.acquire()
  const a3 = await lim.acquire()   // 第 3 次应等到 ~300ms
  const took = Date.now() - t0
  assert(a3.waitedMs > 0, `window: rpm=2 时第 3 次应等待（waited=${a3.waitedMs}ms）`)
  assert(took >= 250 && took < 1000, `window: 等待时长 ≈300ms（实际 ${took}ms）`)
}

async function testMultiKeyCapacity() {
  // 2 keys × rpm=2 = 4 次瞬时放行，第 5 次等待
  const lim = new ProviderLimiter('t', [{ key: 'AAAAAAAAAAAA1111' }, { key: 'BBBBBBBBBBBB2222' }], 2, mkOpts('round-robin', 2000))
  const t0 = Date.now()
  const a1 = await lim.acquire(); const a2 = await lim.acquire()
  const a3 = await lim.acquire(); const a4 = await lim.acquire()
  const fast = Date.now() - t0
  assert(fast < 500, `multi-key: 2 keys × rpm=2 -> 前 4 次无需等（实际 ${fast}ms）`)
  const a5 = await lim.acquire()
  assert(a5.waitedMs > 0, `multi-key: 第 5 次应等待（单 key 情形 3 次即需等；waited=${a5.waitedMs}ms）`)
}

async function testCooldownSkipsKey() {
  const lim = new ProviderLimiter('t', [{ key: 'AAAAAAAAAAAA1111' }, { key: 'BBBBBBBBBBBB2222' }], 100, mkOpts('round-robin', 5000))
  const a = await lim.acquire()           // key A
  lim.mark429(a.tail)                      // 冷却 A（≈100ms）
  const next = await lim.acquire()
  assert(next.tail !== a.tail, `cooldown: 429 后应避开冷却 key，换用另一把（用了 ${next.tail}）`)
}

async function testSingleKeyAllWait() {
  // 单 key + 429 冷却：所有请求都应等待 cooldown 结束
  const lim = new ProviderLimiter('t', [{ key: 'AAAAAAAAAAAA1111' }], 100, mkOpts('round-robin', 5000))
  const a = await lim.acquire()
  lim.mark429(a.tail)                       // 冷却唯一 key ≈100ms
  const t0 = Date.now()
  const next = await lim.acquire()
  const took = Date.now() - t0
  assert(next.waitedMs > 0, `single-key 429: 冷却期间下一次请求应等待（waited=${next.waitedMs}ms）`)
  assert(took >= 60, `single-key 429: 实际耗时含冷却（${took}ms）`)
}

async function main() {
  await testRoundRobin()
  await testWindowThrottle()
  await testMultiKeyCapacity()
  await testCooldownSkipsKey()
  await testSingleKeyAllWait()
  console.log('done.')
}

main()
