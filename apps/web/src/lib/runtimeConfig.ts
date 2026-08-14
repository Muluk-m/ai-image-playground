/**
 * 运行时配置加载。Boot 时 fetch `/runtime-config.json` 一次：
 *   - 200 + parseRuntimeConfig 成功 → 用 fetched config
 *   - 任何错误（404 / parse 失败 / schema 不匹配 / 网络错误）→ 退到 BAKED_DEFAULTS
 *
 * BAKED_DEFAULTS 的 `bff.enabled=false` 意味着「纯静态 BYOK」是默认形态；
 * operator 部署 BFF 时必须显式写一份 `runtime-config.json` 把 `bff.enabled` 打开。
 *
 * 缓存策略：仅 boot 时拉一次，整个 SPA 生命周期内 `getRuntimeConfig()` 同步返回。
 * 切换 BFF / 默认值需要刷新页面，跟「环境配置」语义一致。
 */
import { BAKED_DEFAULTS, parseRuntimeConfig, type RuntimeConfig } from '@image-playground/shared'

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

let cached: RuntimeConfig = BAKED_DEFAULTS

const RUNTIME_CONFIG_PATH = './runtime-config.json'

export async function loadRuntimeConfig(fetcher: Fetcher = fetch): Promise<RuntimeConfig> {
  try {
    const res = await fetcher(RUNTIME_CONFIG_PATH, { cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    cached = parseRuntimeConfig(await res.json())
  } catch (err) {
    if (import.meta.env.MODE !== 'test') {
      console.info(
        '[runtime-config] using baked defaults (file missing or invalid):',
        err instanceof Error ? err.message : err,
      )
    }
    cached = BAKED_DEFAULTS
  }
  return cached
}

export function getRuntimeConfig(): RuntimeConfig {
  return cached
}

/** 仅供测试：直接塞入 config，绕过 fetch。 */
export function _setRuntimeConfigForTesting(config: RuntimeConfig): void {
  cached = config
}
