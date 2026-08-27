import type { Plugin } from "@opencode-ai/plugin"
import { loadConfig } from './config'
import { KeyRotator } from './key-rotator'
import { TokenBucket } from './token-bucket'
import { ExponentialBackoff } from './exponential-backoff'
import { StatsCollector } from './stats'
import { PluginConfig } from './types'

const DEFAULT_CONFIG_PATH = undefined

export const PoorguyRatelimit: Plugin = async ({ client, project, directory }) => {
  const config = await loadConfig(DEFAULT_CONFIG_PATH)
  
  if (!config.enabled) {
    return {}
  }

  const rotator = new KeyRotator()
  const buckets: Map<string, TokenBucket> = new Map()
  const backoff = new ExponentialBackoff(
    config.backoff.maxRetries,
    config.backoff.baseDelayMs,
    config.backoff.maxDelayMs,
    config.backoff.jitterFactor
  )
  const statsCollector = new StatsCollector()

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

  async function toast(message: string, variant: 'info' | 'success' | 'error' | 'warning' = 'info') {
    await client.tui.showToast({
      body: { message, variant }
    })
  }

  return {
    "chat.params": async (input, output) => {
      const providerName = input.provider.id
      
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
        await toast(`Rate limited, waiting ${Math.ceil(waitTime/1000)}s...`, 'warning')
        
        await new Promise(resolve => setTimeout(resolve, waitTime))
        bucket.tryConsume()
      }

      rotator.markUsed(providerName, selectedKey.key)
      statsCollector.recordRequest(providerName, selectedKey.key)

      output.options = output.options || {}
      output.options.apiKey = selectedKey.key
      
      await log(`Using key ${selectedKey.name} for ${providerName}`, 'debug')
    },

    event: async ({ event }) => {
      if (event.type === 'session.error') {
        const error = event.properties?.error
        if (error?.status === 429 || error?.message?.includes('rate limit')) {
          const providerName = error?.provider
          const keyUsed = error?.key
          
          if (providerName && keyUsed) {
            rotator.mark429(providerName, keyUsed)
            statsCollector.record429(providerName, keyUsed)
            
            await log(`429 error for key ${keyUsed.slice(-4)} on ${providerName}, switching key`, 'warn')
            await toast(`429 error! Switching key...`, 'error')
          } else {
            await log(`429 error detected: ${error.message}`, 'warn')
            await toast(`429 rate limit error!`, 'error')
          }
        }
      }
    }
  }
}

export default PoorguyRatelimit
