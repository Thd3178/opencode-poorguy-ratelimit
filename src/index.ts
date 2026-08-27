import type { Plugin } from "@opencode-ai/plugin"
import { loadConfig } from './config'
import { KeyRotator } from './key-rotator'
import { TokenBucket } from './token-bucket'
import { PluginConfig, Stats } from './types'

const DEFAULT_CONFIG_PATH = undefined

export const PoorguyRatelimit: Plugin = async ({ client, project, directory }) => {
  const config = await loadConfig(DEFAULT_CONFIG_PATH)
  
  if (!config.enabled) {
    return {}
  }

  const rotator = new KeyRotator()
  const buckets: Map<string, TokenBucket> = new Map()
  const stats: Stats = {
    totalRequests: 0,
    successfulRequests: 0,
    rateLimitedRequests: 0,
    errors429: 0,
    totalWaitTime: 0,
    byProvider: {},
    byKey: {}
  }

  for (const [name, providerConfig] of Object.entries(config.providers)) {
    rotator.addProvider(name, providerConfig)
    
    const bucketConfig = {
      size: providerConfig.bucket?.size ?? Math.ceil(providerConfig.rpm / 2),
      refillRate: providerConfig.bucket?.refillRate ?? providerConfig.rpm / 60
    }
    
    for (const key of providerConfig.keys) {
      const keyStr = typeof key === 'string' ? key : key.key
      buckets.set(`${name}:${keyStr}`, new TokenBucket(bucketConfig.size, bucketConfig.refillRate))
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

  return {
    "chat.params": async (input, output) => {
      const providerName = input.provider.id
      
      if (!config.providers[providerName]) {
        return
      }

      stats.totalRequests++
      if (!stats.byProvider[providerName]) {
        stats.byProvider[providerName] = { requests: 0, errors429: 0, waitTime: 0 }
      }
      stats.byProvider[providerName].requests++

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
        stats.rateLimitedRequests++
        stats.totalWaitTime += waitTime
        stats.byProvider[providerName].waitTime += waitTime
        
        await log(`Rate limited for ${providerName}, waiting ${waitTime}ms`, 'info')
        
        await new Promise(resolve => setTimeout(resolve, waitTime))
        bucket.tryConsume()
      }

      rotator.markUsed(providerName, selectedKey.key)
      stats.successfulRequests++
      
      if (!stats.byKey[bucketKey]) {
        stats.byKey[bucketKey] = { requests: 0, errors429: 0, lastUsed: 0 }
      }
      stats.byKey[bucketKey].requests++
      stats.byKey[bucketKey].lastUsed = Date.now()

      output.options = output.options || {}
      output.options.apiKey = selectedKey.key
      
      await log(`Using key ${selectedKey.name} for ${providerName}`, 'debug')
    },

    event: async ({ event }) => {
      if (event.type === 'session.error') {
        const error = event.properties?.error
        if (error?.status === 429 || error?.message?.includes('rate limit')) {
          stats.errors429++
          await log(`429 error detected: ${error.message}`, 'warn')
        }
      }
    }
  }
}

export default PoorguyRatelimit
