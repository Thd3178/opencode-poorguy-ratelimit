import type { Plugin } from "@opencode-ai/plugin"
import { loadConfig } from './config'
import { ProviderLimiter, wrapFetch } from './fetch-interceptor'
import { fileLog, LOG_FILE, setLogEnabled } from './logger'

/** NIM 按分钟限流，窗口给 1s 余量；冷却也不超过这个值，避免错过窗口重置 */
const NIM_WINDOW_MS = 61_000

export const PoorguyRatelimit: Plugin = async ({ client }) => {
  const config = await loadConfig()
  if (!config.enabled) return {}

  setLogEnabled(config.logging.enabled)

  const limiters = new Map<string, ProviderLimiter>()
  for (const [name, p] of Object.entries(config.providers)) {
    const keys = (p.keys as any[]).map(k => typeof k === 'string' ? { key: k } : k)
    limiters.set(name, new ProviderLimiter(name, keys, p.rpm ?? 40, {
      windowMs: NIM_WINDOW_MS,
      baseCooldownMs: config.backoff.baseDelayMs,
      maxCooldownMs: Math.min(config.backoff.maxDelayMs, NIM_WINDOW_MS),
      maxConcurrent: p.maxConcurrent ?? 2,
      strategy: config.strategy,
      onWait: (ms) => {
        toast(`⏳ [${name}] 触发限流，等待 ${(ms / 1000).toFixed(1)}s（${limiters.get(name)?.remaining() ?? 0} 剩余额度）`, 'warning')
      }
    }))
    fileLog('info', `plugin ready: provider=${name} keys=${keys.length} rpm=${p.rpm ?? 40} strategy=${config.strategy} logFile=${LOG_FILE}`)
  }

  async function toast(message: string, variant: 'info' | 'success' | 'error' | 'warning' = 'info') {
    try { await client.tui.showToast({ body: { message, variant } }) } catch {}
  }

  return {
    config: async (cfg) => {
      for (const [name, limiter] of limiters) {
        const providerCfg = (cfg.provider as any)?.[name]
        if (!providerCfg) {
          fileLog('warn', `provider '${name}' 配置了插件但 opencode 配置里找不到，跳过拦截`)
          continue
        }
        providerCfg.options = providerCfg.options ?? {}
        const prev: typeof globalThis.fetch = providerCfg.options.fetch ?? globalThis.fetch
        providerCfg.options.fetch = wrapFetch(prev, limiter, toast)
        fileLog('info', `fetch wrapped for provider=${name}`)
      }
    }
  }
}

export default PoorguyRatelimit
