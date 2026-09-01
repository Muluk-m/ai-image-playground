export const OAUTH_PROVIDER_IDS = ['google', 'feishu'] as const

export type OAuthProviderId = (typeof OAUTH_PROVIDER_IDS)[number]

/** Sanitized provider descriptor. Client secrets never leave the BFF process. */
export interface OAuthProviderView {
  readonly id: OAuthProviderId
  readonly label: string
}

export interface OAuthProvidersResponse {
  readonly providers: readonly OAuthProviderView[]
}

/** Callback failures redirect to the frontend with this query parameter instead of rendering a 500. */
export const OAUTH_ERROR_QUERY_PARAM = 'auth_error'

export function isOAuthProviderId(value: string): value is OAuthProviderId {
  return (OAUTH_PROVIDER_IDS as readonly string[]).includes(value)
}
