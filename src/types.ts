export interface KeyConfig {
  key: string
  name?: string
}

export interface BucketConfig {
  size: number
  refillRate: number
}

export interface ProviderConfig {
  keys: (string | KeyConfig)[]
  rpm: number
  bucket?: Partial<BucketConfig>
}

export interface BackoffConfig {
  enabled: boolean
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  jitterFactor: number
}

export interface LoggingConfig {
  enabled: boolean
  level: 'debug' | 'info' | 'warn' | 'error'
}

export interface StatsConfig {
  enabled: boolean
}

export interface PluginConfig {
  enabled: boolean
  strategy: 'round-robin' | 'least-used' | 'random'
  providers: Record<string, ProviderConfig>
  backoff: BackoffConfig
  logging: LoggingConfig
  stats: StatsConfig
}

export interface KeyState {
  key: string
  name: string
  tokens: number
  lastRefill: number
  requestCount: number
  error429Count: number
  lastUsed: number
}

export interface ProviderState {
  keys: KeyState[]
  currentIndex: number
}

export interface Stats {
  totalRequests: number
  successfulRequests: number
  rateLimitedRequests: number
  errors429: number
  totalWaitTime: number
  byProvider: Record<string, {
    requests: number
    errors429: number
    waitTime: number
  }>
  byKey: Record<string, {
    requests: number
    errors429: number
    lastUsed: number
  }>
}
