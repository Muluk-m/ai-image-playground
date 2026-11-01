import type { OAuthProviderDefinition } from './provider'

const PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/

const DEFINITIONS = new Map<string, OAuthProviderDefinition>()

function validateDefinition(definition: OAuthProviderDefinition): void {
  if (!definition || typeof definition !== 'object') {
    throw new Error('invalid OAuth provider definition')
  }
  if (!PROVIDER_ID.test(typeof definition.id === 'string' ? definition.id : '')) {
    throw new Error(`invalid OAuth provider id: ${String(definition.id)}`)
  }
  if (typeof definition.label !== 'string' || !definition.label.trim()) {
    throw new Error(`invalid OAuth provider label: ${definition.id}`)
  }
  const credentials = definition.credentialEnv
  if (
    !credentials ||
    typeof credentials.clientId !== 'string' ||
    !credentials.clientId.trim() ||
    typeof credentials.clientSecret !== 'string' ||
    !credentials.clientSecret.trim()
  ) {
    throw new Error(`invalid OAuth provider credentials: ${definition.id}`)
  }
  if (typeof definition.defaultScope !== 'string' || !definition.defaultScope.trim()) {
    throw new Error(`invalid OAuth provider scope: ${definition.id}`)
  }
  if (
    typeof definition.authorizeUrl !== 'function' ||
    typeof definition.resolveIdentity !== 'function'
  ) {
    throw new Error(`invalid OAuth provider implementation: ${definition.id}`)
  }
}

/**
 * Register private providers without importing BFF config. Validation is complete before
 * mutating the registry, so a malformed or duplicate batch cannot leave partial state.
 */
export function registerOAuthProviders(definitions: readonly OAuthProviderDefinition[]): void {
  if (!Array.isArray(definitions)) throw new Error('OAuth provider definitions must be an array')
  const pending = new Set<string>()
  for (const definition of definitions) {
    validateDefinition(definition)
    if (DEFINITIONS.has(definition.id) || pending.has(definition.id)) {
      throw new Error(`duplicate OAuth provider: ${definition.id}`)
    }
    pending.add(definition.id)
  }
  for (const definition of definitions) DEFINITIONS.set(definition.id, definition)
}

export function getOAuthProviderDefinition(id: string): OAuthProviderDefinition | undefined {
  return DEFINITIONS.get(id)
}

export function listOAuthProviderDefinitions(): readonly OAuthProviderDefinition[] {
  return [...DEFINITIONS.values()]
}
