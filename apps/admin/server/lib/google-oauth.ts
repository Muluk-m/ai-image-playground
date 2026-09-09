import { createHash, randomBytes } from 'node:crypto'
import { config } from '../config'

// Endpoints copied from https://accounts.google.com/.well-known/openid-configuration.
const AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo'
const SCOPE = 'openid email'

export type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

let fetchImpl: FetchImpl = fetch

export function setGoogleFetchForTesting(impl?: FetchImpl): void {
  fetchImpl = impl ?? fetch
}

export interface PkceChallenge {
  readonly state: string
  readonly verifier: string
  readonly challenge: string
}

export function createPkceChallenge(): PkceChallenge {
  const verifier = randomBytes(32).toString('base64url')
  return {
    state: randomBytes(32).toString('base64url'),
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
  }
}

export function googleAuthorizeUrl(input: {
  redirectUri: string
  state: string
  challenge: string
}): string {
  const url = new URL(AUTHORIZE_ENDPOINT)
  url.searchParams.set('client_id', config.google.clientId)
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', SCOPE)
  url.searchParams.set('state', input.state)
  url.searchParams.set('code_challenge', input.challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('prompt', 'select_account')
  return url.toString()
}

export type GoogleIdentityResult =
  | { readonly ok: true; readonly email: string }
  | { readonly ok: false; readonly reason: 'oauth_failed' | 'not_allowed' }

/** Exchange the code and return the verified address, lowercased for the allowlist compare. */
export async function resolveGoogleEmail(input: {
  code: string
  redirectUri: string
  verifier: string
}): Promise<GoogleIdentityResult> {
  let profile: Record<string, unknown>
  try {
    const tokenResponse = await fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        client_id: config.google.clientId,
        client_secret: config.google.clientSecret,
        redirect_uri: input.redirectUri,
        code_verifier: input.verifier,
      }).toString(),
    })
    if (!tokenResponse.ok) return { ok: false, reason: 'oauth_failed' }
    const token = (await tokenResponse.json()) as { access_token?: unknown }
    if (typeof token.access_token !== 'string' || !token.access_token) {
      return { ok: false, reason: 'oauth_failed' }
    }

    const userinfoResponse = await fetchImpl(USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/json' },
    })
    if (!userinfoResponse.ok) return { ok: false, reason: 'oauth_failed' }
    profile = (await userinfoResponse.json()) as Record<string, unknown>
  } catch {
    return { ok: false, reason: 'oauth_failed' }
  }

  const email = typeof profile.email === 'string' ? profile.email.trim().toLowerCase() : ''
  if (!email || profile.email_verified !== true) return { ok: false, reason: 'not_allowed' }
  return { ok: true, email }
}

export function isAllowedAdminEmail(email: string): boolean {
  return config.google.allowedEmails.includes(email.trim().toLowerCase())
}
