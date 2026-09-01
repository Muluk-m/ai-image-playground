import {
  OAuthExchangeError,
  type OAuthProviderDefinition,
  optionalString,
  requireString,
} from './provider'

// Endpoints copied from https://accounts.google.com/.well-known/openid-configuration.
const AUTHORIZE_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo'

export const googleProvider: OAuthProviderDefinition = {
  id: 'google',
  label: 'Google',
  authorizeUrl({ credentials, redirectUri, state }) {
    const url = new URL(AUTHORIZE_ENDPOINT)
    url.searchParams.set('client_id', credentials.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', 'openid email profile')
    url.searchParams.set('state', state)
    return url.toString()
  },
  async resolveIdentity({ credentials, code, redirectUri, fetchImpl }) {
    const tokenResponse = await fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        redirect_uri: redirectUri,
      }).toString(),
    })
    if (!tokenResponse.ok) {
      throw new OAuthExchangeError('exchange_failed', `token HTTP ${tokenResponse.status}`)
    }
    const token = (await tokenResponse.json()) as Record<string, unknown>
    const accessToken = requireString(token.access_token, 'exchange_failed', 'access_token')

    const userResponse = await fetchImpl(USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    })
    if (!userResponse.ok) {
      throw new OAuthExchangeError('identity_failed', `userinfo HTTP ${userResponse.status}`)
    }
    const profile = (await userResponse.json()) as Record<string, unknown>
    return {
      subject: requireString(profile.sub, 'identity_failed', 'sub'),
      // An unverified address must not seed an account username that looks owned.
      email: profile.email_verified === true ? optionalString(profile.email) : null,
      displayName: optionalString(profile.name),
    }
  },
}
