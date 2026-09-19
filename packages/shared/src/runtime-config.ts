/**
 * 前端运行时配置协议。Boot 时 fetch `/runtime-config.json`：
 *   - 200 + parseRuntimeConfig 成功 → 用 RuntimeConfig
 *   - 任何错误（404 / JSON 损坏 / 校验失败）→ 退到 BAKED_DEFAULTS
 *
 * operator 通过这个文件显式 opt-in BFF 功能。文件不存在 = 纯静态 BYOK 模式。
 */
import { parseRuntimeOrigins } from './runtime-origins.mjs'

export interface RuntimeConfig {
  bff: RuntimeBffConfig
  localCompatibility?: { sourceOrigin: string; targetOrigin: string }
}

export interface RuntimeBffConfig {
  /** 唯一功能开关：是否启用 BFF queue 路径与内置 channel 发现。 */
  enabled: boolean
  /**
   * BFF base URL。空字符串 = 同源（推荐，BFF + dist 同进程托管）。
   * 跨域部署（如 cf tunnel）时填具体 origin（不带尾斜杠）。
   */
  baseUrl: string
  /** 多个前端域名共享发布包时，各自保持原 API 的第一方登录 Cookie。 */
  baseUrlsByOrigin?: Record<string, string>
}

/**
 * 没有 `/runtime-config.json` 时使用的内嵌默认值：纯 BYOK，不向 BFF 发任何请求。
 */
export const BAKED_DEFAULTS: RuntimeConfig = Object.freeze({
  bff: Object.freeze({ enabled: false, baseUrl: '' }) as RuntimeBffConfig,
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

  let baseUrlsByOrigin: Record<string, string> | undefined
  try {
    baseUrlsByOrigin = parseRuntimeOrigins(bffRaw.baseUrlsByOrigin)
  } catch (error) {
    throw new RuntimeConfigParseError((error as Error).message)
  }

  let localCompatibility: RuntimeConfig['localCompatibility']
  if (input.localCompatibility !== undefined) {
    const value = input.localCompatibility
    if (!isObject(value)) throw new RuntimeConfigParseError('Invalid localCompatibility')
    for (const key of ['sourceOrigin', 'targetOrigin']) {
      const origin = value[key]
      if (
        typeof origin !== 'string' ||
        !/^https:\/\//.test(origin) ||
        new URL(origin).origin !== origin
      )
        throw new RuntimeConfigParseError('Compatibility requires exact HTTPS origins')
    }
    if (value.sourceOrigin === value.targetOrigin)
      throw new RuntimeConfigParseError('Compatibility origins must differ')
    localCompatibility = value as { sourceOrigin: string; targetOrigin: string }
  }
  return {
    ...(localCompatibility ? { localCompatibility } : {}),
    bff: {
      enabled: bffRaw.enabled,
      baseUrl: bffRaw.baseUrl.replace(/\/+$/, ''),
      ...(baseUrlsByOrigin ? { baseUrlsByOrigin } : {}),
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
