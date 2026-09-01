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
  /** Environment variable names holding this provider's credentials. */
  readonly credentialEnv: { readonly clientId: string; readonly clientSecret: string }
  readonly defaultScope: string
  authorizeUrl(input: {
    credentials: OAuthCredentials
    redirectUri: string
    state: string
    scope: string
  }): string
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

type JsonRecord = Record<string, unknown>

async function readJson(
  response: Response,
  code: OAuthExchangeError['code'],
  what: string,
): Promise<JsonRecord> {
  if (!response.ok) throw new OAuthExchangeError(code, `${what} HTTP ${response.status}`)
  return (await response.json()) as JsonRecord
}

/**
 * Both providers exchange the code and then read the profile with the resulting bearer token;
 * only the request encoding, the extra body check, and the profile shape differ.
 */
export async function exchangeCodeForProfile(input: {
  fetchImpl: typeof fetch
  tokenEndpoint: string
  tokenRequest: RequestInit
  userinfoEndpoint: string
  /** Providers that signal failure inside a 200 response body check it here. */
  assertBody?: (body: JsonRecord, code: OAuthExchangeError['code']) => void
}): Promise<JsonRecord> {
  const token = await readJson(
    await input.fetchImpl(input.tokenEndpoint, input.tokenRequest),
    'exchange_failed',
    'token',
  )
  input.assertBody?.(token, 'exchange_failed')
  const accessToken = requireString(token.access_token, 'exchange_failed', 'access_token')

  const profile = await readJson(
    await input.fetchImpl(input.userinfoEndpoint, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    }),
    'identity_failed',
    'userinfo',
  )
  input.assertBody?.(profile, 'identity_failed')
  return profile
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
