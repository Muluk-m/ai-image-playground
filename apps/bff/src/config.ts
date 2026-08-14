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

export const config = {
  port: Number(env('PORT', '37377')),
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
  },
  databaseUrl: env('DATABASE_URL', '../../artifacts/image-playground.sqlite'),
  corsOrigins: env('CORS_ALLOWED_ORIGINS', '*'),
  staticDir: env('STATIC_DIR', '') || null,
  /** 可选 channels.json 路径覆盖；缺省走 lib/channels.ts 的 defaultChannelsPath()。 */
  channelsFile: env('CHANNELS_FILE', '') || null,
  worker: {
    pollIntervalMs: positiveIntEnv('WORKER_POLL_INTERVAL_MS', 1_000),
    concurrency: {
      openaiCompat: positiveIntEnv('WORKER_OPENAI_CONCURRENCY', 1),
      gemini: positiveIntEnv('WORKER_GEMINI_CONCURRENCY', 2),
    },
  },
}
