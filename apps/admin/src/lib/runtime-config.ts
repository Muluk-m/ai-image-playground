import { BAKED_DEFAULTS, parseRuntimeConfig, type RuntimeConfig } from '@image-playground/shared'

const RUNTIME_CONFIG_PATH = '/runtime-config.json'
const RUNTIME_CONFIG_TIMEOUT_MS = 5_000

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

let cached: RuntimeConfig = BAKED_DEFAULTS

export async function loadAdminRuntimeConfig(fetcher: Fetcher = fetch): Promise<RuntimeConfig> {
  try {
    const response = await fetcher(RUNTIME_CONFIG_PATH, {
      cache: 'no-store',
      signal: AbortSignal.timeout(RUNTIME_CONFIG_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    cached = parseRuntimeConfig(await response.json())
  } catch (error) {
    if (import.meta.env.MODE !== 'test') {
      console.info(
        '[runtime-config] using same-origin admin API:',
        error instanceof Error ? error.message : error,
      )
    }
    cached = BAKED_DEFAULTS
  }
  return cached
}

export function adminApiBaseUrl(): string {
  return cached.bff.baseUrl.replace(/\/+$/, '')
}

export function adminApiUrl(path: string): string {
  if (!path.startsWith('/')) throw new Error(`Admin API path must start with /: ${path}`)
  return `${adminApiBaseUrl()}${path}`
}

export function _setAdminRuntimeConfigForTesting(config: RuntimeConfig): void {
  cached = config
}
