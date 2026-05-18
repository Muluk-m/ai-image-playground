const env = (key: string, fallback?: string): string => {
  const v = process.env[key]
  if (v && v.trim()) return v.trim()
  if (fallback !== undefined) return fallback
  throw new Error(`Missing env: ${key}`)
}

export const config = {
  port: Number(env('PORT', '37377')),
  /**
   * 上游单 endpoint fallback：worker 默认走 `upstream.baseUrl + provider 派生路径`，
   * 适合所有 channels 共用同一上游网关（如自建反代）的部署。多 channel + 多上游
   * 的真正分发要等到 worker 切换成读 channels.json 里 channel.baseUrl/auth.secret。
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
}
