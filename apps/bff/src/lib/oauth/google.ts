import {
  exchangeCodeForProfile,
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
  credentialEnv: { clientId: 'OAUTH_GOOGLE_CLIENT_ID', clientSecret: 'OAUTH_GOOGLE_CLIENT_SECRET' },
  defaultScope: 'openid email profile',
  authorizeUrl({ credentials, redirectUri, state, scope }) {
    const url = new URL(AUTHORIZE_ENDPOINT)
    url.searchParams.set('client_id', credentials.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('state', state)
    if (scope) url.searchParams.set('scope', scope)
    return url.toString()
  },
  async resolveIdentity({ credentials, code, redirectUri, fetchImpl }) {
    const profile = await exchangeCodeForProfile({
      fetchImpl,
      tokenEndpoint: TOKEN_ENDPOINT,
      tokenRequest: {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          redirect_uri: redirectUri,
        }).toString(),
      },
      userinfoEndpoint: USERINFO_ENDPOINT,
    })
    return {
      subject: requireString(profile.sub, 'identity_failed', 'sub'),
      // An unverified address must not seed an account username that looks owned.
      email: profile.email_verified === true ? optionalString(profile.email) : null,
      displayName: optionalString(profile.name),
    }
  },
}
