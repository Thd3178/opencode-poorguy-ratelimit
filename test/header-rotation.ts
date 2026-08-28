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
  { windowMs: 60000, backoff: { enabled: true, maxRetries: 3, baseDelayMs: 5000, maxDelayMs: 120000, jitterFactor: 0.2 }, strategy: 'round-robin' }
)
const wf = wrapFetch(stubFetch, lim, async () => {}, false)

for (let i = 0; i < 6; i++) await wf('http://x', { headers: { Authorization: 'Bearer ORIGINAL' } })
console.log(calls.join(' | '))
