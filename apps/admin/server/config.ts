import type { ClientCapabilityManifest } from '@image-playground/shared'

const env = (key: string, fallback?: string): string => {
  const v = process.env[key]
  if (v && v.trim()) return v.trim()
  if (fallback !== undefined) return fallback
  throw new Error(`Missing env: ${key}`)
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
    get internalApiToken(): string {
      return env('INTERNAL_API_TOKEN', '')
    },
  },
  assertValid(): void {
    if (resolvedAdminCapabilities.accountsLogin && !config.auth.internalApiToken) {
      throw new Error('Missing env: INTERNAL_API_TOKEN')
    }
  },
  databaseUrl: env('DATABASE_URL'),
  corsOrigins: env('CORS_ALLOWED_ORIGINS', '*'),
  // admin 前端 dist 目录；为空时 server 不挂静态托管（dev 模式由 vite 跑前端）
  staticDir: env('ADMIN_DIST_DIR', ''),
}
export interface ResolvedAdminCapabilities {
  readonly accountsLogin: boolean
}

let resolvedAdminCapabilities: ResolvedAdminCapabilities = Object.freeze({
  accountsLogin: false,
})

export function getAdminCapabilities(): ResolvedAdminCapabilities {
  return resolvedAdminCapabilities
}

export function setAdminCapabilitiesForTesting(capabilities: ResolvedAdminCapabilities): void {
  resolvedAdminCapabilities = Object.freeze({ ...capabilities })
}

export async function loadAdminCapabilities(
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
): Promise<void> {
  const response = await fetchImpl(`${config.bffInternalUrl}/api/capabilities`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    throw new Error(`Cannot resolve Admin capabilities: HTTP ${response.status}`)
  }
  const body = (await response.json()) as Partial<ClientCapabilityManifest>
  if (typeof body['accounts:login'] !== 'boolean') {
    throw new Error('Cannot resolve Admin capabilities: invalid manifest')
  }
  resolvedAdminCapabilities = Object.freeze({
    accountsLogin: body['accounts:login'],
  })
}
