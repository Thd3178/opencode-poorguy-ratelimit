# @thd3178/opencode-poorguy-ratelimit

OpenCode 插件 - 多API Key轮询 + Token Bucket限流，突破单Key RPM限制，预防429错误。

## 功能特性

- **多Key轮询**：Round-Robin / Least-Used / Random 三种策略
- **Token Bucket限流**：主动控制每个Key的请求速率，预防429
- **自动切换**：某个Key被限流/429时，自动切换到其他Key
- **指数退避**：429错误时自动等待重试
- **详细统计**：记录每个Key的使用情况、429次数等

## 安装

```bash
npm install @thd3178/opencode-poorguy-ratelimit
```

## 配置

在 `~/.config/opencode/opencode.json` 中添加插件：

```json
{
  "plugin": ["@thd3178/opencode-poorguy-ratelimit"]
}
```

创建配置文件 `~/.config/opencode/opencode-poorguy-ratelimit.jsonc`：

```jsonc
{
  // 插件总开关
  "enabled": true,
  
  // 轮询策略：round-robin | least-used | random
  "strategy": "round-robin",
  
  // 需要轮询的provider配置
  "providers": {
    "nvidia-nim": {
      "keys": [
        "sk-xxx1",
        "sk-xxx2"
      ],
      "rpm": 40
    }
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
```

## 配置说明

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | boolean | true | 是否启用插件 |
| `strategy` | string | "round-robin" | 轮询策略 |
| `providers` | object | {} | 需要轮询的provider配置 |
| `providers[name].keys` | string[] | - | API Key列表 |
| `providers[name].rpm` | number | - | 每分钟请求数限制 |
| `backoff.enabled` | boolean | true | 是否启用指数退避 |
| `backoff.maxRetries` | number | 3 | 最大重试次数 |
| `backoff.baseDelayMs` | number | 5000 | 基础延迟（毫秒） |
| `backoff.maxDelayMs` | number | 120000 | 最大延迟（毫秒） |
| `backoff.jitterFactor` | number | 0.2 | 抖动系数 |
| `logging.enabled` | boolean | true | 是否启用日志 |
| `logging.level` | string | "info" | 日志级别 |
| `stats.enabled` | boolean | true | 是否启用统计 |

## Token Bucket 参数

插件会根据 `rpm` 自动计算 Token Bucket 参数：

- `bucket.size = rpm / 2`（桶容量，控制突发能力）
- `bucket.refillRate = rpm / 60`（补充速率，控制平均速率）

也可以手动覆盖：

```jsonc
{
  "rpm": 40,
  "bucket": {
    "size": 30,
    "refillRate": 0.5
  }
}
```

## 工作原理

```
请求来了
  ↓
轮询选择一个Key（round-robin/least-used/random）
  ↓
检查该Key的Token Bucket
  ↓
有Token → 消耗Token → 发送请求
  ↓
没Token → 该Key被限流 → 自动切换到其他Key
  ↓
所有Key都没Token → 等待补充
```

## 许可证

MIT
