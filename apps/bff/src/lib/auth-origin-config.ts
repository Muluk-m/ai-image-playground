import { isOAuthProviderId } from '@image-playground/shared'

export interface LoginOriginPolicy {
  readonly origin: string
  readonly password: boolean
  readonly registration: boolean
  readonly providers: readonly string[]
}

export function parseLoginMethodsByOrigin(value: unknown): readonly LoginOriginPolicy[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('AUTH_LOGIN_METHODS_BY_ORIGIN must be a JSON object')
  }
  const entries: LoginOriginPolicy[] = []
  for (const [origin, raw] of Object.entries(value)) {
    let parsed: URL
    try {
      parsed = new URL(origin)
    } catch {
      throw new Error('AUTH_LOGIN_METHODS_BY_ORIGIN keys must be bare http(s) origins')
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      parsed.username ||
      parsed.password ||
      parsed.origin !== origin
    ) {
      throw new Error('AUTH_LOGIN_METHODS_BY_ORIGIN keys must be bare http(s) origins')
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`AUTH_LOGIN_METHODS_BY_ORIGIN[${origin}] must be an object`)
    }
    const record = raw as Record<string, unknown>
    if (
      Object.keys(record).some((key) => !['password', 'registration', 'providers'].includes(key))
    ) {
      throw new Error(`AUTH_LOGIN_METHODS_BY_ORIGIN[${origin}] contains an unknown key`)
    }
    if (typeof record.password !== 'boolean' || typeof record.registration !== 'boolean') {
      throw new Error(
        `AUTH_LOGIN_METHODS_BY_ORIGIN[${origin}] password and registration must be booleans`,
      )
    }
    if (
      !Array.isArray(record.providers) ||
      record.providers.some(
        (provider) => typeof provider !== 'string' || !isOAuthProviderId(provider),
      )
    ) {
      throw new Error(`AUTH_LOGIN_METHODS_BY_ORIGIN[${origin}].providers must be provider ids`)
    }
    entries.push({
      origin,
      password: record.password,
      registration: record.registration,
      providers: [...new Set(record.providers as string[])],
    })
  }
  return entries
}
