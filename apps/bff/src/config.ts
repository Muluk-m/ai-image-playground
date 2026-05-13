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
  },
  databaseUrl: env('DATABASE_URL', '../../artifacts/image-playground.sqlite'),
  corsOrigins: env('CORS_ALLOWED_ORIGINS', '*'),
}
