import {
  isOAuthProviderId,
  OAUTH_PROVIDER_IDS,
  type OAuthProviderId,
  type OAuthProviderView,
} from '@image-playground/shared'
import { config } from '../../config'
import { feishuProvider } from './feishu'
import { googleProvider } from './google'
import type { OAuthCredentials, OAuthProviderDefinition } from './provider'

export type { OAuthCredentials, OAuthIdentity, OAuthProviderDefinition } from './provider'
export { OAuthExchangeError } from './provider'

const DEFINITIONS: Readonly<Record<OAuthProviderId, OAuthProviderDefinition>> = {
  google: googleProvider,
  feishu: feishuProvider,
}

export interface EnabledOAuthProvider {
  readonly definition: OAuthProviderDefinition
  readonly credentials: OAuthCredentials
}

/** A provider is enabled only when both of its secrets are present. */
export function resolveOAuthProvider(provider: string): EnabledOAuthProvider | null {
  if (!isOAuthProviderId(provider)) return null
  const credentials = config.oauth.credentials(provider)
  if (!credentials.clientId || !credentials.clientSecret) return null
  return { definition: DEFINITIONS[provider], credentials }
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
