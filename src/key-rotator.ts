import { TokenBucket } from './token-bucket'
import { KeyConfig, KeyState, ProviderConfig, ProviderState } from './types'
import { getProviderBucket } from './config'

export type Strategy = 'round-robin' | 'least-used' | 'random'

export class KeyRotator {
  private providers: Map<string, ProviderState> = new Map()

  addProvider(name: string, config: ProviderConfig): void {
    const bucketConfig = getProviderBucket(config)
    const keys: KeyState[] = config.keys.map((k) => ({
      key: k.key,
      name: k.name || k.key.slice(-4),
      tokens: bucketConfig.size,
      lastRefill: Date.now(),
      requestCount: 0,
      error429Count: 0,
      lastUsed: 0
    }))

    this.providers.set(name, {
      keys,
      currentIndex: 0
    })
  }

  getKey(providerName: string, strategy: Strategy): KeyState | null {
    const state = this.providers.get(providerName)
    if (!state || state.keys.length === 0) return null

    switch (strategy) {
      case 'round-robin':
        return this.roundRobin(state)
      case 'least-used':
        return this.leastUsed(state)
      case 'random':
        return this.random(state)
      default:
        return this.roundRobin(state)
    }
  }

  markUsed(providerName: string, key: string): void {
    const state = this.providers.get(providerName)
    if (!state) return
    const keyState = state.keys.find((k) => k.key === key)
    if (keyState) {
      keyState.requestCount++
      keyState.lastUsed = Date.now()
    }
  }

  mark429(providerName: string, key: string): void {
    const state = this.providers.get(providerName)
    if (!state) return
    const keyState = state.keys.find((k) => k.key === key)
    if (keyState) {
      keyState.error429Count++
    }
  }

  getKeyState(providerName: string, key: string): KeyState | undefined {
    const state = this.providers.get(providerName)
    if (!state) return undefined
    return state.keys.find((k) => k.key === key)
  }

  getAllProviders(): string[] {
    return Array.from(this.providers.keys())
  }

  private roundRobin(state: ProviderState): KeyState {
    const key = state.keys[state.currentIndex]
    state.currentIndex = (state.currentIndex + 1) % state.keys.length
    return key
  }

  private leastUsed(state: ProviderState): KeyState {
    return state.keys.reduce((min, curr) =>
      curr.requestCount < min.requestCount ? curr : min
    )
  }

  private random(state: ProviderState): KeyState {
    const index = Math.floor(Math.random() * state.keys.length)
    return state.keys[index]
  }
}
