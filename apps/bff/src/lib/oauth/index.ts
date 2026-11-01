import { type OAuthProviderView } from '@image-playground/shared'
import { config } from '../../config'
import { googleProvider } from './google'
import type { OAuthCredentials, OAuthProviderDefinition } from './provider'
import {
  getOAuthProviderDefinition,
  listOAuthProviderDefinitions,
  registerOAuthProviders,
} from './registry'

export type { OAuthIdentity, OAuthProviderDefinition } from './provider'
export { OAuthExchangeError } from './provider'
export { registerOAuthProviders } from './registry'

registerOAuthProviders([googleProvider])

export interface EnabledOAuthProvider {
  readonly definition: OAuthProviderDefinition
  readonly credentials: OAuthCredentials
  readonly scope: string
}

export function resolveOAuthProvider(provider: string): EnabledOAuthProvider | null {
  const definition = getOAuthProviderDefinition(provider)
  if (!definition) return null
  const credentials = {
    clientId: config.oauth.secret(definition.credentialEnv.clientId),
    clientSecret: config.oauth.secret(definition.credentialEnv.clientSecret),
  }
  if (!credentials.clientId || !credentials.clientSecret) return null
  return { definition, credentials, scope: definition.defaultScope }
}

export function enabledOAuthProviders(): OAuthProviderView[] {
  return listOAuthProviderDefinitions()
    .filter((definition) => resolveOAuthProvider(definition.id) !== null)
    .map((definition) => ({ id: definition.id, label: definition.label }))
}

let fetchImpl: typeof fetch = globalThis.fetch

export function oauthFetch(): typeof fetch {
  return fetchImpl
}

export function setOAuthFetchForTesting(impl?: typeof fetch): void {
  fetchImpl = impl ?? globalThis.fetch
}
