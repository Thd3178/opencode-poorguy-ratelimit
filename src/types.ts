export interface KeyConfig {
  key: string
  /** 展示名，默认取 key 尾 4 位 */
  name?: string
}

export interface ProviderConfig {
  keys?: (string | KeyConfig)[]
  /** 每把 key 每分钟请求上限，默认 40 */
  rpm?: number
  /** 同一时刻最多并发请求数，默认 2 */
  maxConcurrent?: number
}

export interface BackoffConfig {
  /** 429 后首次冷却毫秒数（无 Retry-After 头时），之后指数翻倍 */
  baseDelayMs: number
  /** 冷却上限毫秒数 */
  maxDelayMs: number
}

export interface LoggingConfig {
  enabled: boolean
}

export interface PluginConfig {
  enabled: boolean
  strategy: 'round-robin' | 'least-used' | 'random'
  providers: Record<string, ProviderConfig>
  backoff: BackoffConfig
  logging: LoggingConfig
}
