import type { OAuthProviderId } from '@image-playground/shared'

export interface OAuthIdentity {
  readonly subject: string
  readonly email: string | null
  readonly displayName: string | null
}

export interface OAuthCredentials {
  readonly clientId: string
  readonly clientSecret: string
}

export interface OAuthProviderDefinition {
  readonly id: OAuthProviderId
  readonly label: string
  authorizeUrl(input: { credentials: OAuthCredentials; redirectUri: string; state: string }): string
  /** Exchanges the authorization code and resolves the provider identity in one step. */
  resolveIdentity(input: {
    credentials: OAuthCredentials
    code: string
    redirectUri: string
    fetchImpl: typeof fetch
  }): Promise<OAuthIdentity>
}

export class OAuthExchangeError extends Error {
  constructor(
    readonly code: 'exchange_failed' | 'identity_failed',
    detail: string,
  ) {
    super(`${code}: ${detail}`)
    this.name = 'OAuthExchangeError'
  }
}

export function requireString(
  value: unknown,
  code: OAuthExchangeError['code'],
  field: string,
): string {
  if (typeof value !== 'string' || !value) throw new OAuthExchangeError(code, `missing ${field}`)
  return value
}

export function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
