import { config } from '../config'
import type { LoginOriginPolicy } from './auth-origin-config'

export type ResolvedLoginPolicy = Omit<LoginOriginPolicy, 'providers'> & {
  /** null preserves all deployment-enabled providers; an explicit empty list denies all. */
  readonly providers: readonly string[] | null
}

export function loginPolicyForOrigin(origin: string): ResolvedLoginPolicy {
  return config.auth.loginMethodsByOrigin.find((entry) => entry.origin === origin) ?? {
    origin,
    password: true,
    registration: true,
    providers: null,
  }
}

/**
 * Entry policy only, never account authorization. Browser Origin is authoritative. Query
 * selectors are supplied only for OAuth discovery/navigation, never password POSTs.
 * Without Origin, POSTs use the API request origin, not a caller-selected frontend.
 */
export function loginOriginPolicy(
  request: Request,
  requested?: unknown,
): ResolvedLoginPolicy | null {
  const apiOrigin = new URL(request.url).origin
  const header = request.headers.get('origin')
  const candidate = header ?? (typeof requested === 'string' ? requested : apiOrigin)
  const policies = config.auth.loginMethodsByOrigin
  if (policies.length > 0) {
    const allowed = config.auth.frontendOrigins
    if (!allowed.includes(candidate) && candidate !== apiOrigin) return null
    try {
      if (new URL(candidate).origin !== candidate) return null
    } catch {
      return null
    }
  }
  return loginPolicyForOrigin(candidate)
}

export function providerAllowed(policy: ResolvedLoginPolicy, provider: string): boolean {
  return policy.providers === null || policy.providers.includes(provider)
}

export function passwordEntryAllowed(request: Request): boolean {
  return loginOriginPolicy(request)?.password === true
}

export function registrationEntryAllowed(request: Request): boolean {
  const policy = loginOriginPolicy(request)
  return policy?.password === true && policy.registration
}
