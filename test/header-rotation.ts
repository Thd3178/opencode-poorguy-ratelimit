import { ProviderLimiter, wrapFetch } from '../src/fetch-interceptor'

const calls: string[] = []
const stubFetch: any = async (_url: any, init: any) => {
  calls.push(new Headers(init?.headers).get('authorization') ?? 'none')
  return new Response('ok', { status: 200 })
}

const lim = new ProviderLimiter(
  'nim',
  [{ key: 'AAAA1111' }, { key: 'BBBB2222' }, { key: 'CCCC3333' }],
  40,
  { windowMs: 61000, baseCooldownMs: 5000, maxCooldownMs: 61000, maxConcurrent: 4, strategy: 'round-robin' }
)
const wf = wrapFetch(stubFetch, lim, async () => {})

// 必须消费响应体：并发槽在流读完时才释放（与真实 SDK 行为一致），不读会一直占用
for (let i = 0; i < 6; i++) {
  const res = await wf('http://x', { headers: { Authorization: 'Bearer ORIGINAL' } })
  await res.text()
}
console.log(calls.join(' | '))
