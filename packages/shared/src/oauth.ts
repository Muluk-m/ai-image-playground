export const OAUTH_PROVIDER_IDS = ['google'] as const

export type OAuthProviderId = (typeof OAUTH_PROVIDER_IDS)[number]

/** Sanitized provider descriptor. Client secrets never leave the BFF process. */
export interface OAuthProviderView {
  readonly id: OAuthProviderId
  readonly label: string
}

export interface OAuthProvidersResponse {
  readonly providers: readonly OAuthProviderView[]
}

/** Callback failures redirect to the frontend carrying this query parameter. */
export const OAUTH_ERROR_QUERY_PARAM = 'auth_error'

/**
 * Link-mode callbacks land on the workbench, not the login screen, so they carry their own
 * parameters instead of OAUTH_ERROR_QUERY_PARAM.
 */
export const OAUTH_LINK_QUERY_PARAM = 'auth_link'
export const OAUTH_LINK_ERROR_QUERY_PARAM = 'auth_link_error'

export function isOAuthProviderId(value: string): value is OAuthProviderId {
  return (OAUTH_PROVIDER_IDS as readonly string[]).includes(value)
}
