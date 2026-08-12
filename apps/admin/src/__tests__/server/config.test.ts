import { describe, expect, it } from 'bun:test'

process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.BFF_INTERNAL_URL = 'http://bff.test:37377'
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'

const { config, getAdminCapabilities, loadAdminCapabilities } = await import(
  '../../../server/config'
)

describe('loadAdminCapabilities', () => {
  it('starts the read-only skeleton without a service credential when login is disabled', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = []
    const disabledFetch = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
      })
      return Response.json({ 'accounts:login': false })
    }

    delete process.env.INTERNAL_API_TOKEN
    try {
      await loadAdminCapabilities(disabledFetch)
      expect(getAdminCapabilities()).toEqual({ accountsLogin: false })
      expect(() => config.assertValid()).not.toThrow()
      expect(requests).toEqual([
        { url: 'http://bff.test:37377/api/capabilities', authorization: null },
      ])
    } finally {
      process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
    }
  })

  it('requires the service credential when login is enabled', async () => {
    const enabledFetch = async () => Response.json({ 'accounts:login': true })

    await loadAdminCapabilities(enabledFetch)
    delete process.env.INTERNAL_API_TOKEN
    try {
      expect(getAdminCapabilities()).toEqual({ accountsLogin: true })
      expect(() => config.assertValid()).toThrow('Missing env: INTERNAL_API_TOKEN')
    } finally {
      process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
    }
  })
})
