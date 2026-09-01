import {
  exchangeCodeForProfile,
  OAuthExchangeError,
  type OAuthProviderDefinition,
  optionalString,
  requireString,
} from './provider'

// Authorization lives on accounts.feishu.cn; token and profile live on open.feishu.cn.
// https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/authorize/get
const AUTHORIZE_ENDPOINT = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize'
const TOKEN_ENDPOINT = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token'
const USERINFO_ENDPOINT = 'https://open.feishu.cn/open-apis/authen/v1/user_info'

export const feishuProvider: OAuthProviderDefinition = {
  id: 'feishu',
  label: '飞书',
  credentialEnv: { clientId: 'OAUTH_FEISHU_APP_ID', clientSecret: 'OAUTH_FEISHU_APP_SECRET' },
  // Requesting a scope the app was never granted fails the whole authorization, so the email
  // scope stays opt-in through OAUTH_FEISHU_SCOPE.
  defaultScope: '',
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
    const body = await exchangeCodeForProfile({
      fetchImpl,
      tokenEndpoint: TOKEN_ENDPOINT,
      tokenRequest: {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      },
      userinfoEndpoint: USERINFO_ENDPOINT,
      // Feishu answers HTTP 200 with a non-zero `code` for business failures.
      assertBody(payload, failure) {
        if (typeof payload.code === 'number' && payload.code !== 0) {
          throw new OAuthExchangeError(failure, `feishu code ${payload.code}`)
        }
      },
    })
    const profile = (body.data ?? {}) as Record<string, unknown>
    return {
      // union_id is stable across the tenant's apps; open_id is only stable per app.
      subject: requireString(
        optionalString(profile.union_id) ?? profile.open_id,
        'identity_failed',
        'union_id',
      ),
      email: optionalString(profile.email) ?? optionalString(profile.enterprise_email),
      displayName: optionalString(profile.name) ?? optionalString(profile.en_name),
    }
  },
}
