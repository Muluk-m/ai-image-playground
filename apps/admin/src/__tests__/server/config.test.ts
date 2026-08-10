import { describe, expect, it } from 'bun:test'

process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.BFF_INTERNAL_URL = 'http://bff.test:37377'
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'

const { getAdminCapabilities, loadAdminCapabilities } = await import('../../../server/config')

describe('loadAdminCapabilities', () => {
  it('requires an explicit operator:console grant from the BFF', async () => {
    const disabledFetch = async () => Response.json({ operator_console: false })

    await expect(loadAdminCapabilities(disabledFetch)).rejects.toThrow(
      'operator:console capability is disabled',
    )
  })

  it('sends the service credential when resolving the capability', async () => {
    const authorizations: Array<string | null> = []
    const enabledFetch = async (_input: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get('authorization'))
      return Response.json({ accounts_login: false, operator_console: true })
    }

    await loadAdminCapabilities(enabledFetch)
    expect(authorizations).toEqual(['Bearer fixture-service-credential-alpha'])
    expect(getAdminCapabilities()).toEqual({ accountsLogin: false })
  })
})
