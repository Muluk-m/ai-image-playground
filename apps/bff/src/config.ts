const env = (key: string, fallback?: string): string => {
  const v = process.env[key]
  if (v && v.trim()) return v.trim()
  if (fallback !== undefined) return fallback
  throw new Error(`Missing env: ${key}`)
}

export const config = {
  port: Number(env('PORT', '37377')),
  sub2api: {
    baseUrl: env('SUB2API_BASE_URL', 'http://localhost:8080').replace(/\/+$/, ''),
    apiKey: env('SUB2API_API_KEY', ''),
    openaiApiKey: env('SUB2API_OPENAI_API_KEY', ''),
    geminiApiKey: env('SUB2API_GEMINI_API_KEY', ''),
  },
  databaseUrl: env('DATABASE_URL', '../../artifacts/image-playground.sqlite'),
  corsOrigins: env('CORS_ALLOWED_ORIGINS', '*'),
  staticDir: env('STATIC_DIR', '') || null,
}
