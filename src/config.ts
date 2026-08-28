import { PluginConfig, ProviderConfig, BucketConfig, KeyConfig } from './types'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { readFile } from 'fs/promises'
import { mkdirSync, writeFileSync } from 'fs'

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

const DEFAULT_RPM = 40

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

function stripJsonComments(text: string): string {
  let result = ''
  let inString = false
  let inBlockComment = false
  let inLineComment = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false
        result += ch
      }
      continue
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false
        i++
      }
      continue
    }

    if (inString) {
      result += ch
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    if (ch === '"') {
      inString = true
      result += ch
    } else if (ch === '/' && next === '/') {
      inLineComment = true
      i++
    } else if (ch === '/' && next === '*') {
      inBlockComment = true
      i++
    } else {
      result += ch
    }
  }

  return result
}

async function readJsonFile(filePath: string): Promise<any> {
  try {
    const content = await readFile(filePath, 'utf-8')
    return JSON.parse(stripJsonComments(content))
  } catch {
    return {}
  }
}

async function loadOpencodeProviderKeys(): Promise<Record<string, string>> {
  const configDir = join(homedir(), '.config', 'opencode')
  const json = await readJsonFile(join(configDir, 'opencode.json'))
  const jsonc = await readJsonFile(join(configDir, 'opencode.jsonc'))

  const keys: Record<string, string> = {}
  const allProviderNames = new Set([
    ...Object.keys(json?.provider ?? {}),
    ...Object.keys(jsonc?.provider ?? {})
  ])

  for (const name of allProviderNames) {
    const provider = jsonc?.provider?.[name] ?? json?.provider?.[name]
    if (provider?.options?.apiKey) {
      keys[name] = provider.options.apiKey
    }
  }

  return keys
}

export function getDefaultConfigPath(): string {
  return join(homedir(), '.config', 'opencode', 'opencode-poorguy-ratelimit.jsonc')
}

export async function validateConfig(raw: any): Promise<PluginConfig> {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid config: must be an object')
  }

  const enabled = raw.enabled !== false
  const strategy = raw.strategy || 'round-robin'

  if (!['round-robin', 'least-used', 'random'].includes(strategy)) {
    throw new Error(`Invalid strategy: ${strategy}`)
  }

  const opencodeKeys = await loadOpencodeProviderKeys()

  const providers: Record<string, ProviderConfig> = {}

  if (raw.providers && typeof raw.providers === 'object') {
    for (const [name, config] of Object.entries(raw.providers)) {
      const pConfig = config as any
      const autoKey = opencodeKeys[name]
      const explicitKeys = pConfig.keys
        ? pConfig.keys.map(normalizeKey)
        : []

      const allKeys = [...explicitKeys]
      if (autoKey && !allKeys.some(k => k.key === autoKey)) {
        allKeys.push(normalizeKey(autoKey))
      }

      if (allKeys.length === 0) {
        throw new Error(`Provider ${name}: no keys found. Add keys in plugin config or set apiKey in opencode.json provider options`)
      }

      providers[name] = {
        keys: allKeys,
        rpm: pConfig.rpm ?? DEFAULT_RPM,
        maxConcurrent: typeof pConfig.maxConcurrent === 'number' && pConfig.maxConcurrent > 0 ? pConfig.maxConcurrent : 2,
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
  const rpm = config.rpm ?? DEFAULT_RPM
  return calculateBucket(rpm, config.bucket)
}

export async function loadConfig(configPath?: string): Promise<PluginConfig> {
  const path = configPath || getDefaultConfigPath()

  let content: string
  try {
    content = await readFile(path, 'utf-8')
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      await createDefaultConfig(path)
      return validateConfig({})
    }
    throw error
  }

  try {
    const raw = JSON.parse(stripJsonComments(content))
    return await validateConfig(raw)
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config file: ${path}`)
    }
    throw error
  }
}

async function createDefaultConfig(path: string): Promise<void> {
  const defaultConfig = `{
  "enabled": true,
  "strategy": "round-robin",
  "providers": {},
  "backoff": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 5000,
    "maxDelayMs": 120000,
    "jitterFactor": 0.2
  },
  "logging": {
    "enabled": true,
    "level": "info"
  },
  "stats": {
    "enabled": true
  }
}
`
  
  try {
    const dir = dirname(path)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, defaultConfig, 'utf-8')
  } catch (e) {
    // Ignore errors if file already exists or cannot be created
  }
}
