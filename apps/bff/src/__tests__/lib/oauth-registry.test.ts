import { describe, expect, it } from 'bun:test'
import type { OAuthProviderDefinition } from '../../lib/oauth/provider'
import { getOAuthProviderDefinition, registerOAuthProviders } from '../../lib/oauth/registry'

function definition(id: string): OAuthProviderDefinition {
  return {
    id,
    label: id,
    credentialEnv: { clientId: `${id}_CLIENT_ID`, clientSecret: `${id}_CLIENT_SECRET` },
    defaultScope: 'openid',
    authorizeUrl: () => 'https://provider.example/authorize',
    resolveIdentity: async () => ({ subject: id, email: null, displayName: null }),
  }
}

describe('OAuth provider registry', () => {
  it('validates a complete batch before registering any definition', () => {
    expect(() =>
      registerOAuthProviders([definition('registry-alpha'), { ...definition('bad id') }]),
    ).toThrow('invalid OAuth provider id')
    expect(getOAuthProviderDefinition('registry-alpha')).toBeUndefined()
    expect(() =>
      registerOAuthProviders([{ ...definition('registry-malformed'), label: '' }]),
    ).toThrow('invalid OAuth provider label')
    expect(getOAuthProviderDefinition('registry-malformed')).toBeUndefined()
  })

  it('rejects duplicate IDs within a batch and against existing providers', () => {
    registerOAuthProviders([definition('registry-duplicate')])
    expect(() => registerOAuthProviders([definition('registry-duplicate')])).toThrow(
      'duplicate OAuth provider',
    )
    expect(() =>
      registerOAuthProviders([definition('registry-batch'), definition('registry-batch')]),
    ).toThrow('duplicate OAuth provider')
    expect(getOAuthProviderDefinition('registry-batch')).toBeUndefined()
  })
})
