/**
 * 前端运行时配置协议。Boot 时 fetch `/runtime-config.json`：
 *   - 200 + parseRuntimeConfig 成功 → 用 RuntimeConfig
 *   - 任何错误（404 / JSON 损坏 / 校验失败）→ 退到 BAKED_DEFAULTS
 *
 * operator 通过这个文件显式 opt-in BFF 功能。文件不存在 = 纯静态 BYOK 模式。
 */
export interface RuntimeConfig {
  bff: RuntimeBffConfig
  auth: RuntimeAuthConfig
  defaults: RuntimeDefaults
}

export interface RuntimeBffConfig {
  /** 唯一功能开关：是否启用 BFF queue 路径与内置 channel 发现。 */
  enabled: boolean
  /**
   * BFF base URL。空字符串 = 同源（推荐，BFF + dist 同进程托管）。
   * 跨域部署（如 cf tunnel）时填具体 origin（不带尾斜杠）。
   */
  baseUrl: string
}

export interface RuntimeAuthConfig {
  /**
   * 是否要求经营站用户登录。只控制前端门禁；真正的安全边界是 BFF 自己的
   * AUTH_ENABLED，不能依赖浏览器传来的这个值。
   */
  enabled: boolean
}

export interface RuntimeDefaults {
  /** BYOK profile 的 baseUrl 占位默认值（OpenAI 兼容）。 */
  openaiBaseUrl: string
  /** Gemini BYOK baseUrl 默认（v1beta endpoint）。 */
  geminiBaseUrl: string
  /** Inspiration manifest 远程 URL。空字符串 = 只用 bundled 资源不远程拉。 */
  inspirationManifestUrl: string
}

/**
 * 没有 `/runtime-config.json` 时使用的内嵌默认值：纯 BYOK，不向 BFF 发任何请求。
 */
export const BAKED_DEFAULTS: RuntimeConfig = Object.freeze({
  bff: Object.freeze({ enabled: false, baseUrl: '' }) as RuntimeBffConfig,
  auth: Object.freeze({ enabled: false }) as RuntimeAuthConfig,
  defaults: Object.freeze({
    openaiBaseUrl: 'https://api.openai.com/v1',
    geminiBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    inspirationManifestUrl: './inspiration-manifest.json',
  }) as RuntimeDefaults,
}) as RuntimeConfig

/**
 * 解析 runtime-config.json 内容。schema 不匹配抛 `RuntimeConfigParseError`；
 * 调用方接住后退到 `BAKED_DEFAULTS`。
 *
 * 容忍 extra 字段（前向兼容）；要求所有声明字段类型严格匹配。
 */
export function parseRuntimeConfig(input: unknown): RuntimeConfig {
  if (!isObject(input)) throw new RuntimeConfigParseError('root must be an object')

  const bffRaw = input.bff
  if (!isObject(bffRaw)) throw new RuntimeConfigParseError('bff must be an object')
  if (typeof bffRaw.enabled !== 'boolean')
    throw new RuntimeConfigParseError('bff.enabled must be boolean')
  if (typeof bffRaw.baseUrl !== 'string')
    throw new RuntimeConfigParseError('bff.baseUrl must be string')

  // 兼容认证功能上线前 operator 手写的 runtime-config.json：缺 auth 等价于
  // 显式关闭。字段一旦存在则严格校验，避免字符串 "false" 被当 truthy。
  const authRaw = input.auth
  if (authRaw !== undefined && !isObject(authRaw))
    throw new RuntimeConfigParseError('auth must be an object')
  if (isObject(authRaw) && typeof authRaw.enabled !== 'boolean')
    throw new RuntimeConfigParseError('auth.enabled must be boolean')

  const defaultsRaw = input.defaults
  if (!isObject(defaultsRaw)) throw new RuntimeConfigParseError('defaults must be an object')
  for (const key of ['openaiBaseUrl', 'geminiBaseUrl', 'inspirationManifestUrl'] as const) {
    if (typeof defaultsRaw[key] !== 'string')
      throw new RuntimeConfigParseError(`defaults.${key} must be string`)
  }

  return {
    bff: {
      enabled: bffRaw.enabled,
      baseUrl: bffRaw.baseUrl.replace(/\/+$/, ''),
    },
    auth: {
      enabled: isObject(authRaw) ? (authRaw.enabled as boolean) : false,
    },
    defaults: {
      openaiBaseUrl: defaultsRaw.openaiBaseUrl as string,
      geminiBaseUrl: defaultsRaw.geminiBaseUrl as string,
      inspirationManifestUrl: defaultsRaw.inspirationManifestUrl as string,
    },
  }
}

export class RuntimeConfigParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuntimeConfigParseError'
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
