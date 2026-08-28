# @thd3178/opencode-poorguy-ratelimit

[中文版 README](README.md)

An OpenCode plugin that rate-limits AI requests to **avoid 429 errors** caused by RPM caps. Supports **API key rotation** across multiple keys to raise effective throughput and reduce time-to-first-token.

## What it does

- **Sliding-window rate limiting**: Enforces per-minute request limits per key; waits when full
- **Key rotation**: round-robin / least-used / random across multiple API keys — throughput scales linearly with key count
- **Prevention + fallback**: Local throttling first; a real 429 triggers exponential cooldown for that key, auto-switching to another if available
- **Transparent**: Doesn't change model behavior, just rotates `Authorization` headers and shapes traffic

## Install

Add to `~/.config/opencode/opencode.jsonc` (or `.json`):

```json
{
  "plugin": [
    "@thd3178/opencode-poorguy-ratelimit"
  ]
}
```

OpenCode will auto-install and load it on next launch.

## Configuration

Config file: `~/.config/opencode/opencode-poorguy-ratelimit.jsonc`.

Minimal (no keys needed here — the plugin auto-reads `options.apiKey` from `opencode.json`):

```jsonc
{
  "providers": {
    "nim": {
      "rpm": 40
    }
  }
}
```

With explicit keys for rotation:

```jsonc
{
  "providers": {
    "nim": {
      "rpm": 40,
      "keys": [
        "nvapi-xxx...",
        "nvapi-yyy..."
      ]
    }
  }
}
```

### Full config reference

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch; `false` = plugin does nothing |
| `strategy` | string | `"round-robin"` | Key selection: `round-robin` / `least-used` / `random` |
| `providers` | object | `{}` | **Only providers listed here are managed.** Unconfigured providers are untouched. |
| `providers.<name>.rpm` | number | `40` | Requests/min per key. Total throughput = `rpm × key count` |
| `providers.<name>.keys` | string[] | auto | Optional extra API keys. If omitted, the plugin reads `options.apiKey` from `opencode.json` for that provider |
| `providers.<name>.maxConcurrent` | number | `2` | Max in-flight requests at any instant. Extra requests queue until predecessors (including streaming) finish. Set low to avoid NIM's concurrent-request 429s |
| `backoff.enabled` | boolean | `true` | Exponential cooldown on 429 per key |
| `backoff.baseDelayMs` | number | `5000` | Initial cooldown (ms) on first 429 |
| `backoff.maxDelayMs` | number | `120000` | Max cooldown (ms) |
| `backoff.jitterFactor` | number | `0.2` | Random jitter to stagger recovery |
| `logging.enabled` | boolean | `true` | Write plugin logs to file |
| `logging.level` | string | `"info"` | `debug` / `info` / `warn` / `error` |

> The provider name must match the **object key** in `opencode.json` under `"providers"`, not the display name.

## How it works

Every request to a provider goes through a wrapped `fetch` call — main conversations, tool-call sub-steps, title generation, subagent requests, everything.

```
request arrives
  → pick next key (round-robin / least-used / random)
  → check that key's sliding 60-second window
  → under limit → send and count
  → at limit → wait for earliest entry to expire, retry
  → hits 429 → exponential cooldown, mark that key, give others a chance
```

Each key gets its own independent sliding window, so N keys give N× effective RPM.

## Logging

- **Toasts** appear in the OpenCode TUI on every request: `🔑 [provider] key…xxxx · window N/rpm · key x/y`
- Rate-limit waits show a warning toast; 429s show an error toast
- Log file: `~/.config/opencode/opencode-poorguy-ratelimit.log` (UTF-8; console may garble if your terminal codec isn't UTF-8)

## FAQ

**Q: I configured multiple keys but saw no speed improvement?**
Most causes: old version cached (clear `~/.cache/opencode/packages/`), or `rpm` set too low. The plugin must be restarted after editing the config file (opencode has no hot-reload).

**Q: Do I need to write apiKey into the plugin config?**
No. With just `"rpm"` the plugin reads your key from `opencode.json`. Only write `keys` if you want to add *extra* keys for rotation.

## License

MIT
