import { config } from '../../config'
import {
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

function assertBusinessSuccess(
  body: Record<string, unknown>,
  code: 'exchange_failed' | 'identity_failed',
): void {
  // Feishu answers HTTP 200 with a non-zero `code` for business failures.
  if (typeof body.code === 'number' && body.code !== 0) {
    throw new OAuthExchangeError(code, `feishu code ${body.code}`)
  }
}

export const feishuProvider: OAuthProviderDefinition = {
  id: 'feishu',
  label: '飞书',
  authorizeUrl({ credentials, redirectUri, state }) {
    const url = new URL(AUTHORIZE_ENDPOINT)
    url.searchParams.set('client_id', credentials.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('state', state)
    // Requesting a scope the app has not been granted fails the whole authorization,
    // so an operator opts into the email scope explicitly.
    const scope = config.oauth.feishuScope
    if (scope) url.searchParams.set('scope', scope)
    return url.toString()
  },
  async resolveIdentity({ credentials, code, redirectUri, fetchImpl }) {
    const tokenResponse = await fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    })
    if (!tokenResponse.ok) {
      throw new OAuthExchangeError('exchange_failed', `token HTTP ${tokenResponse.status}`)
    }
    const token = (await tokenResponse.json()) as Record<string, unknown>
    assertBusinessSuccess(token, 'exchange_failed')
    const accessToken = requireString(token.access_token, 'exchange_failed', 'access_token')

    const userResponse = await fetchImpl(USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    })
    if (!userResponse.ok) {
      throw new OAuthExchangeError('identity_failed', `user_info HTTP ${userResponse.status}`)
    }
    const body = (await userResponse.json()) as Record<string, unknown>
    assertBusinessSuccess(body, 'identity_failed')
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
