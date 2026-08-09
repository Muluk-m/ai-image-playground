const env = (key: string, fallback?: string): string => {
  const v = process.env[key]
  if (v && v.trim()) return v.trim()
  if (fallback !== undefined) return fallback
  throw new Error(`Missing env: ${key}`)
}

const booleanEnv = (key: string, fallback: boolean): boolean => {
  const value = env(key, String(fallback))
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${key} must be true or false`)
}

const cookieSecret = env('ADMIN_COOKIE_SECRET')
if (cookieSecret.length < 32) {
  throw new Error('ADMIN_COOKIE_SECRET must be at least 32 chars')
}

export const config = {
  port: Number(env('PORT', '37378')),
  adminPassword: env('ADMIN_PASSWORD'),
  cookieSecret,
  bffInternalUrl: env('BFF_INTERNAL_URL', 'http://127.0.0.1:37377').replace(/\/+$/, ''),
  auth: {
    get enabled(): boolean {
      return booleanEnv('AUTH_ENABLED', false)
    },
    get internalApiToken(): string {
      return env('INTERNAL_API_TOKEN', '')
    },
  },
  assertValid(): void {
    if (config.auth.enabled && !config.auth.internalApiToken) {
      throw new Error('Missing env: INTERNAL_API_TOKEN')
    }
  },
  databaseUrl: env('DATABASE_URL'),
  corsOrigins: env('CORS_ALLOWED_ORIGINS', '*'),
  // admin 前端 dist 目录；为空时 server 不挂静态托管（dev 模式由 vite 跑前端）
  staticDir: env('ADMIN_DIST_DIR', ''),
}
