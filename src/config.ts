import { PluginConfig, ProviderConfig, BucketConfig, KeyConfig } from './types'
import { join } from 'path'
import { homedir } from 'os'

const DEFAULT_BACKOFF = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 5000,
  maxDelayMs: 120000,
  jitterFactor: 0.2
}

const DEFAULT_LOGGING = {
  enabled: true,
  level: 'info' as const
}

const DEFAULT_STATS = {
  enabled: true
}

function calculateBucket(rpm: number, override?: Partial<BucketConfig>): BucketConfig {
  return {
    size: override?.size ?? Math.ceil(rpm / 2),
    refillRate: override?.refillRate ?? rpm / 60
  }
}

function normalizeKey(key: string | KeyConfig): KeyConfig {
  if (typeof key === 'string') {
    return { key, name: key.slice(-4) }
  }
  return { ...key, name: key.name ?? key.key.slice(-4) }
}

export function getDefaultConfigPath(): string {
  return join(homedir(), '.config', 'opencode', 'opencode-poorguy-ratelimit.jsonc')
}

export function validateConfig(raw: any): PluginConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid config: must be an object')
  }

  const enabled = raw.enabled !== false
  const strategy = raw.strategy || 'round-robin'

  if (!['round-robin', 'least-used', 'random'].includes(strategy)) {
    throw new Error(`Invalid strategy: ${strategy}`)
  }

  const providers: Record<string, ProviderConfig> = {}
  if (raw.providers && typeof raw.providers === 'object') {
    for (const [name, config] of Object.entries(raw.providers)) {
      const pConfig = config as any
      if (!pConfig.keys || !Array.isArray(pConfig.keys) || pConfig.keys.length === 0) {
        throw new Error(`Provider ${name}: keys must be a non-empty array`)
      }
      if (!pConfig.rpm || typeof pConfig.rpm !== 'number' || pConfig.rpm <= 0) {
        throw new Error(`Provider ${name}: rpm must be a positive number`)
      }
      providers[name] = {
        keys: pConfig.keys.map(normalizeKey),
        rpm: pConfig.rpm,
        bucket: pConfig.bucket
      }
    }
  }

  return {
    enabled,
    strategy: strategy as PluginConfig['strategy'],
    providers,
    backoff: { ...DEFAULT_BACKOFF, ...raw.backoff },
    logging: { ...DEFAULT_LOGGING, ...raw.logging },
    stats: { ...DEFAULT_STATS, ...raw.stats }
  }
}

export function getProviderBucket(config: ProviderConfig): BucketConfig {
  return calculateBucket(config.rpm, config.bucket)
}

export async function loadConfig(configPath?: string): Promise<PluginConfig> {
  const path = configPath || getDefaultConfigPath()
  
  try {
    const file = Bun.file(path)
    const exists = await file.exists()
    
    if (!exists) {
      await createDefaultConfig(path)
      return validateConfig({})
    }
    
    const content = await file.text()
    const raw = JSON.parse(content)
    return validateConfig(raw)
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config file: ${path}`)
    }
    throw error
  }
}

async function createDefaultConfig(path: string): Promise<void> {
  const defaultConfig = `{
  // 插件总开关
  "enabled": true,
  
  // 轮询策略：round-robin | least-used | random
  "strategy": "round-robin",
  
  // 需要轮询的provider配置
  // 请添加你的API keys
  "providers": {
    // "nvidia-nim": {
    //   "keys": ["sk-your-key-1", "sk-your-key-2"],
    //   "rpm": 40
    // }
  },

  // 429错误处理（指数退避）
  "backoff": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 5000,
    "maxDelayMs": 120000,
    "jitterFactor": 0.2
  },

  // 日志配置
  "logging": {
    "enabled": true,
    "level": "info"
  },

  // 统计配置
  "stats": {
    "enabled": true
  }
}
`
  
  const dir = path.substring(0, path.lastIndexOf('/'))
  await Bun.spawn(['mkdir', '-p', dir]).exited
  await Bun.write(path, defaultConfig)
}
