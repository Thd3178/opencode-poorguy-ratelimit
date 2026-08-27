import type { Plugin } from "@opencode-ai/plugin"
import { loadConfig } from './config'
import { KeyRotator } from './key-rotator'
import { TokenBucket } from './token-bucket'
import { ExponentialBackoff } from './exponential-backoff'
import { StatsCollector } from './stats'

const DEFAULT_CONFIG_PATH = undefined

export const PoorguyRatelimit: Plugin = async ({ client, project, directory }) => {
  const config = await loadConfig(DEFAULT_CONFIG_PATH)
  
  if (!config.enabled) {
    return {}
  }

  const rotator = new KeyRotator()
  const buckets: Map<string, TokenBucket> = new Map()
  const bucketSizes: Map<string, number> = new Map()
  const backoff = new ExponentialBackoff(
    config.backoff.maxRetries,
    config.backoff.baseDelayMs,
    config.backoff.maxDelayMs,
    config.backoff.jitterFactor
  )
  const statsCollector = new StatsCollector()
  const sessionKeys: Map<string, { provider: string; key: string }> = new Map()

  for (const [name, providerConfig] of Object.entries(config.providers)) {
    rotator.addProvider(name, providerConfig)
    
    const bucketConfig = {
      size: providerConfig.bucket?.size ?? Math.ceil(providerConfig.rpm / 2),
      refillRate: providerConfig.bucket?.refillRate ?? providerConfig.rpm / 60
    }
    
    for (const key of providerConfig.keys) {
      const keyStr = typeof key === 'string' ? key : key.key
      const bucketKeyStr = `${name}:${keyStr}`
      buckets.set(bucketKeyStr, new TokenBucket(bucketConfig.size, bucketConfig.refillRate))
      bucketSizes.set(bucketKeyStr, bucketConfig.size)
    }
  }

  async function log(message: string, level: 'debug' | 'info' | 'warn' | 'error' = 'info') {
    if (!config.logging.enabled) return
    const levels = ['debug', 'info', 'warn', 'error']
    if (levels.indexOf(level) < levels.indexOf(config.logging.level)) return
    
    await client.app.log({
      body: {
        service: 'poorguy-ratelimit',
        level,
        message,
      }
    })
  }

  async function toast(message: string, variant: 'info' | 'success' | 'error' | 'warning' = 'info') {
    await client.tui.showToast({
      body: { message, variant }
    })
  }

  return {
    "chat.params": async (input, output) => {
      const providerName = input.model.providerID
      
      if (!config.providers[providerName]) {
        return
      }

      const selectedKey = rotator.getKey(providerName, config.strategy)
      if (!selectedKey) {
        await log(`No keys available for provider: ${providerName}`, 'warn')
        return
      }

      const bucketKey = `${providerName}:${selectedKey.key}`
      const bucket = buckets.get(bucketKey)
      if (!bucket) {
        await log(`No bucket found for key: ${bucketKey}`, 'error')
        return
      }

      if (!bucket.tryConsume()) {
        const waitTime = bucket.getWaitTime()
        statsCollector.recordRateLimit(providerName, waitTime)
        
        await log(`Rate limited for ${providerName}, waiting ${waitTime}ms`, 'info')
        await toast(`⏳ Bucket [${selectedKey.name}] empty, waiting ${Math.ceil(waitTime/1000)}s...`, 'warning')
        
        await new Promise(resolve => setTimeout(resolve, waitTime))
        bucket.tryConsume()
      }

      rotator.markUsed(providerName, selectedKey.key)
      statsCollector.recordRequest(providerName, selectedKey.key)
      sessionKeys.set(input.sessionID, { provider: providerName, key: selectedKey.key })

      const tokensAfter = bucket.getTokens()
      const bucketSize = bucketSizes.get(bucketKey) || 20
      await toast(`🔑 Key [${selectedKey.name}] | Bucket: ${Math.floor(tokensAfter)}/${bucketSize}`, 'info')

      output.options = output.options || {}
      output.options.apiKey = selectedKey.key
      
      await log(`Using key ${selectedKey.name} for ${providerName}, tokens: ${Math.floor(tokensAfter)}`, 'debug')
    },

    event: async ({ event }) => {
      if (event.type === 'session.error') {
        const error = event.properties?.error as { name?: string; data?: { statusCode?: number; message?: string; providerID?: string } } | undefined
        const status = error?.data?.statusCode
        const message = String(error?.data?.message ?? '')
        const is429 = status === 429 || /rate limit|too_many_requests/i.test(message)

        if (is429) {
          const sessionID = event.properties?.sessionID
          const sessionKey = sessionID ? sessionKeys.get(sessionID) : undefined

          if (sessionKey) {
            const keyState = rotator.getKeyState(sessionKey.provider, sessionKey.key)
            const cooldownMs = config.backoff.enabled && keyState
              ? backoff.calculateDelay(keyState.error429Count)
              : 0
            rotator.mark429(sessionKey.provider, sessionKey.key, cooldownMs)
            statsCollector.record429(sessionKey.provider, sessionKey.key)

            await log(`429 for key ${sessionKey.key.slice(-4)} on ${sessionKey.provider}, cooldown ${cooldownMs}ms`, 'warn')
            await toast(`429! Key [${sessionKey.key.slice(-4)}] cooling ${Math.ceil(cooldownMs / 1000)}s`, 'error')
          } else {
            await log(`429 error (no session context): ${message}`, 'warn')
            await toast(`429 rate limit error!`, 'error')
          }
        }
      }
    }
  }
}

export default PoorguyRatelimit
