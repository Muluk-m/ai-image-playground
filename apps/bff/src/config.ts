import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import { normalizeKeyPrefix } from './lib/objectKeyPrefix'
import { hasCapability, loadOperatorConfig } from './lib/operator-config'

const env = (key: string, fallback?: string): string => {
  const v = process.env[key]
  if (v && v.trim()) return v.trim()
  if (fallback !== undefined) return fallback
  throw new Error(`Missing env: ${key}`)
}

const positiveIntEnv = (key: string, fallback: number): number => {
  const value = Number(env(key, String(fallback)))
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`)
  }
  return value
}
const booleanEnv = (key: string, fallback: boolean): boolean => {
  const value = env(key, String(fallback)).toLowerCase()
  if (value !== 'true' && value !== 'false') throw new Error(`${key} must be true or false`)
  return value === 'true'
}
const clientIpSource = env('CLIENT_IP_SOURCE', 'peer')
if (
  clientIpSource !== 'peer' &&
  clientIpSource !== 'x-forwarded-for' &&
  clientIpSource !== 'cf-connecting-ip'
) {
  throw new Error('CLIENT_IP_SOURCE must be peer, x-forwarded-for, or cf-connecting-ip')
}
const operator = loadOperatorConfig(env('OPERATOR_CONFIG_FILE', '') || null)
const workerPollIntervalMs = positiveIntEnv('WORKER_POLL_INTERVAL_MS', 1_000)
const workerHealthStaleAfterMs = positiveIntEnv(
  'WORKER_HEALTH_STALE_AFTER_MS',
  Math.max(10_000, workerPollIntervalMs * 5),
)

export const config = {
  port: Number(env('PORT', '37377')),
  auth: {
    get internalApiToken(): string {
      return env('INTERNAL_API_TOKEN', '')
    },
    /** Origin the OAuth provider redirects back to. Empty means derive it from the request. */
    get publicOrigin(): string {
      return env('AUTH_PUBLIC_ORIGIN', '').replace(/\/+$/, '')
    },
    /** Origin the OAuth callback finally lands on. Empty falls back to the first CORS origin. */
    get frontendOrigin(): string {
      return env('AUTH_FRONTEND_ORIGIN', '').replace(/\/+$/, '')
    },
  },
  oauth: {
    /** Provider secrets are read lazily so an operator can rotate them with a restart. */
    secret(name: string): string {
      return env(name, '')
    },
  },
  assertValid(): void {
    if (hasCapability(config.operator, 'accounts:login') && !config.auth.internalApiToken) {
      throw new Error('Missing env: INTERNAL_API_TOKEN')
    }
    if (config.worker.healthStaleAfterMs < config.worker.pollIntervalMs * 3) {
      throw new Error('WORKER_HEALTH_STALE_AFTER_MS must be at least three poll intervals')
    }
  },
  /**
   * 上游单 endpoint fallback：worker 默认走 `upstream.baseUrl + provider 派生路径`，
   * 适合所有 channels 共用同一上游网关（如自建反代）的部署。**不含版本段**
   * （/v1、/v1beta 由 upstream.ts 拼）。独立直连上游的 channel（如 agnes、grok）
   * 不走这里，见 upstream.ts 的 CHANNEL_ROUTE_STYLES（单源 channels.json）。
   */
  upstream: {
    baseUrl: env('UPSTREAM_BASE_URL', 'http://localhost:8080').replace(/\/+$/, ''),
    apiKey: env('UPSTREAM_API_KEY', ''),
    openaiApiKey: env('UPSTREAM_OPENAI_API_KEY', ''),
    geminiApiKey: env('UPSTREAM_GEMINI_API_KEY', ''),
    /**
     * 通用网关提供 sub2api 风格的异步图片任务端点。不能写进 channels.json：网关部署里
     * 那些 channel 的 baseUrl 只是名义地址，网关是哪一家只有 env 知道（见 apps/bff/CLAUDE.md）。
     */
    asyncImageTasks: booleanEnv('UPSTREAM_ASYNC_IMAGE_TASKS', false),
  },
  databaseUrl: env('DATABASE_URL'),
  corsOrigins: env('CORS_ALLOWED_ORIGINS', '*'),
  /** Explicit origins from CORS_ALLOWED_ORIGINS; empty when the deployment allows any origin. */
  get corsOriginList(): string[] {
    if (config.corsOrigins === '*') return []
    return config.corsOrigins
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin && origin !== '*')
  },
  staticDir: env('STATIC_DIR', '') || null,
  network: {
    clientIpSource,
  },
  /** 可选 channels.json 路径覆盖；缺省走 lib/channels.ts 的 defaultChannelsPath()。 */
  channelsFile: operator.channelsFile ?? (env('CHANNELS_FILE', '') || null),
  operator,
  objectStore: {
    get endpoint(): string {
      return env('S3_ENDPOINT')
    },
    get bucket(): string {
      return env('S3_BUCKET')
    },
    get accessKeyId(): string {
      return env('S3_ACCESS_KEY_ID')
    },
    get secretAccessKey(): string {
      return env('S3_SECRET_ACCESS_KEY')
    },
    get keyPrefix(): string {
      return normalizeKeyPrefix(process.env.S3_KEY_PREFIX)
    },
  },
  worker: {
    pollIntervalMs: workerPollIntervalMs,
    /** 调大要连带调大进程管理器的停机宽限（deploy/compose.app.yaml），否则先挨 SIGKILL。 */
    drainTimeoutMs: positiveIntEnv(
      'WORKER_DRAIN_TIMEOUT_MS',
      QUEUE_TIMEOUTS.SHUTDOWN_DRAIN_TIMEOUT_MS,
    ),
    healthPort: positiveIntEnv('WORKER_HEALTH_PORT', 37_379),
    healthStaleAfterMs: workerHealthStaleAfterMs,
    concurrency: {
      openaiCompat: positiveIntEnv('WORKER_OPENAI_CONCURRENCY', 1),
      gemini: positiveIntEnv('WORKER_GEMINI_CONCURRENCY', 2),
    },
  },
}
