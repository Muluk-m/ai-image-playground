/**
 * 运行时配置加载。Boot 时 fetch `/runtime-config.json` 一次：
 *   - 200 + parseRuntimeConfig 成功 → 用 fetched config
 *   - 文件不存在 / parse 失败 / schema 不匹配 → 退到 BAKED_DEFAULTS
 *   - 网络错误 / 超时 / 服务异常 → 抛错，由启动页提供重试
 *
 * BAKED_DEFAULTS 的 `bff.enabled=false` 意味着默认不连接 BFF、没有平台渠道；
 * operator 部署 BFF 时必须显式写一份 `runtime-config.json` 把 `bff.enabled` 打开。
 *
 * 缓存策略：仅 boot 时拉一次，整个 SPA 生命周期内 `getRuntimeConfig()` 同步返回。
 * 切换 BFF / 默认值需要刷新页面，跟「环境配置」语义一致。
 */
import { BAKED_DEFAULTS, parseRuntimeConfig, type RuntimeConfig } from '@image-playground/shared'

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

let cached: RuntimeConfig = BAKED_DEFAULTS

const RUNTIME_CONFIG_PATH = '/runtime-config.json'

/**
 * main.tsx 在 render 之前 top-level await 这个函数，所以它必须保证会结束：
 * 卡住的连接（tunnel / 代理挂起、不返回也不断开）会让 React 永远不 mount，
 * 用户看到的是永久白屏。超时交给启动页重试，不能把连接失败当作运营关闭 BFF。
 */
const RUNTIME_CONFIG_TIMEOUT_MS = 5000

export async function loadRuntimeConfig(fetcher: Fetcher = fetch): Promise<RuntimeConfig> {
  const res = await fetcher(RUNTIME_CONFIG_PATH, {
    cache: 'no-store',
    signal: AbortSignal.timeout(RUNTIME_CONFIG_TIMEOUT_MS),
  })
  if (!res.ok && res.status !== 404) throw new Error(`runtime_config_http_${res.status}`)
  try {
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    cached = parseRuntimeConfig(await res.json())
    const origin = globalThis.location?.origin
    const scopedBaseUrl = origin && cached.bff.baseUrlsByOrigin?.[origin]
    if (scopedBaseUrl) cached = { ...cached, bff: { ...cached.bff, baseUrl: scopedBaseUrl } }
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

/**
 * BFF base URL，尾斜杠已去掉。空字符串 = 同源（BFF 同进程托管前端 dist，最常见形态）；
 * 非空 = 跨域（如 cf tunnel），fetch 走绝对 URL。
 */
export function bffBaseUrl(): string {
  return cached.bff.baseUrl.replace(/\/+$/, '')
}

/** 仅供测试：直接塞入 config，绕过 fetch。 */
export function _setRuntimeConfigForTesting(config: RuntimeConfig): void {
  cached = config
}
