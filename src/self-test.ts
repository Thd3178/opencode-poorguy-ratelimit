import { ProviderLimiter } from './fetch-interceptor'

const mkOpts = (strategy: 'round-robin' | 'least-used' | 'random', windowMs: number) => ({
  windowMs, baseCooldownMs: 100, maxCooldownMs: 1000, maxConcurrent: 100, strategy,
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

async function testConcurrencyGate() {
  const lim = new ProviderLimiter('t', [{ key: 'AAAAAAAAAAAA1111' }], 100,
    { windowMs: 60000, baseCooldownMs: 100, maxCooldownMs: 500, maxConcurrent: 2, strategy: 'round-robin' })

  let inflight = 0
  let maxInflight = 0
  let completed = 0
  const total = 6

  await Promise.all(Array.from({ length: total }, () => (async () => {
    await lim.acquire()
    await lim.acquireSlot()
    inflight++
    maxInflight = Math.max(maxInflight, inflight)
    await new Promise(r => setTimeout(r, 120))
    lim.releaseSlot()
    inflight--
    completed++
  })()))

  assert(completed === total, `并发闸门：6 个请求都能完成（完成 ${completed}）`)
  assert(maxInflight <= 2, `并发闸门：同时在走的不超过 2（峰值 ${maxInflight}）`)

  // 排队行为验证：第 3 个必须等待前两个之一释放
  let secondRoundSawTwo = false
  const order: string[] = []
  const lim2 = new ProviderLimiter('t', [{ key: 'BBBB1111' }], 100,
    { windowMs: 60000, baseCooldownMs: 100, maxCooldownMs: 500, maxConcurrent: 1, strategy: 'round-robin' })
  const tasks = ['a','b'].map(id => (async () => {
    await lim2.acquire()
    await lim2.acquireSlot()
    order.push(`in:${id}`)
    await new Promise(r => setTimeout(r, 80))
    lim2.releaseSlot()
  })().then(() => order.push(`out:${id}`)))
  await Promise.all(tasks)
  const idx = JSON.stringify(order)
  assert(order.indexOf('in:a') < order.indexOf('in:b') && order.indexOf('in:b') > order.indexOf('out:a'),
    `并发闸门 maxConcurrent=1 串行化：b 在 a 完成后才开始（order=${idx}）`)
}

async function main() {
  await testRoundRobin()
  await testWindowThrottle()
  await testMultiKeyCapacity()
  await testCooldownSkipsKey()
  await testSingleKeyAllWait()
  await testConcurrencyGate()
  console.log('done.')
}

main()
