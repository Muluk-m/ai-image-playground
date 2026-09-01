import {
  isOAuthProviderId,
  OAUTH_PROVIDER_IDS,
  type OAuthProviderId,
  type OAuthProviderView,
} from '@image-playground/shared'
import { config } from '../../config'
import { googleProvider } from './google'
import type { OAuthCredentials, OAuthProviderDefinition } from './provider'

export type { OAuthIdentity } from './provider'
export { OAuthExchangeError } from './provider'

const DEFINITIONS: Readonly<Record<OAuthProviderId, OAuthProviderDefinition>> = {
  google: googleProvider,
}

export interface EnabledOAuthProvider {
  readonly definition: OAuthProviderDefinition
  readonly credentials: OAuthCredentials
  readonly scope: string
}

export function resolveOAuthProvider(provider: string): EnabledOAuthProvider | null {
  if (!isOAuthProviderId(provider)) return null
  const definition = DEFINITIONS[provider]
  const credentials = {
    clientId: config.oauth.secret(definition.credentialEnv.clientId),
    clientSecret: config.oauth.secret(definition.credentialEnv.clientSecret),
  }
  if (!credentials.clientId || !credentials.clientSecret) return null
  return {
    definition,
    credentials,
    scope: config.oauth.scope(provider, definition.defaultScope),
  }
}

export function enabledOAuthProviders(): OAuthProviderView[] {
  return OAUTH_PROVIDER_IDS.filter((id) => resolveOAuthProvider(id) !== null).map((id) => ({
    id,
    label: DEFINITIONS[id].label,
  }))
}

let fetchImpl: typeof fetch = globalThis.fetch

export function oauthFetch(): typeof fetch {
  return fetchImpl
}

export function setOAuthFetchForTesting(impl?: typeof fetch): void {
  fetchImpl = impl ?? globalThis.fetch
}
