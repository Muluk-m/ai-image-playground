import {
  OAuthExchangeError,
  type OAuthProviderDefinition,
  optionalString,
  requireString,
} from '../../../lib/oauth/provider'

const AUTHORIZE_ENDPOINT = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize'
const TOKEN_ENDPOINT = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token'
const USERINFO_ENDPOINT = 'https://open.feishu.cn/open-apis/authen/v1/user_info'

type JsonRecord = Record<string, unknown>

async function readJson(
  response: Response,
  code: OAuthExchangeError['code'],
  what: string,
): Promise<JsonRecord> {
  if (!response.ok) throw new OAuthExchangeError(code, `${what} HTTP ${response.status}`)
  const payload = (await response.json()) as unknown
  if (!payload || typeof payload !== 'object') {
    throw new OAuthExchangeError(code, `${what} returned invalid JSON`)
  }
  const record = payload as JsonRecord
  if (record.code !== undefined && record.code !== 0) {
    const message = typeof record.msg === 'string' ? record.msg : `code ${String(record.code)}`
    throw new OAuthExchangeError(code, `${what}: ${message}`)
  }
  return record
}

function dataObject(payload: JsonRecord, what: string): JsonRecord {
  const data = payload.data
  if (!data || typeof data !== 'object') {
    throw new OAuthExchangeError('identity_failed', `${what} missing data`)
  }
  return data as JsonRecord
}

export const feishuProvider: OAuthProviderDefinition = {
  id: 'feishu',
  label: '飞书',
  credentialEnv: {
    clientId: 'OAUTH_FEISHU_CLIENT_ID',
    clientSecret: 'OAUTH_FEISHU_CLIENT_SECRET',
  },
  defaultScope: 'contact:user.base:readonly contact:user.email:readonly',
  authorizeUrl({ credentials, redirectUri, state, scope }) {
    const url = new URL(AUTHORIZE_ENDPOINT)
    url.searchParams.set('client_id', credentials.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('state', state)
    url.searchParams.set('scope', scope)
    return url.toString()
  },
  async resolveIdentity({ credentials, code, redirectUri, fetchImpl }) {
    const tokenPayload = await readJson(
      await fetchImpl(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
        }),
      }),
      'exchange_failed',
      'token',
    )
    const accessToken = requireString(tokenPayload.access_token, 'exchange_failed', 'access_token')

    const profilePayload = await readJson(
      await fetchImpl(USERINFO_ENDPOINT, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      }),
      'identity_failed',
      'userinfo',
    )
    const profile = dataObject(profilePayload, 'userinfo')

    const subject = optionalString(profile.open_id)
    if (!subject) throw new OAuthExchangeError('identity_failed', 'missing open_id')

    const email = optionalString(profile.email)
    return {
      subject,
      email,
      // Admin-managed contact email is metadata, not proof of mailbox ownership.
      emailVerified: false,
      displayName: optionalString(profile.name) ?? optionalString(profile.en_name),
    }
  },
}
