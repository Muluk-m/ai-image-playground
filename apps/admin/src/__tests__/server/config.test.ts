import { describe, expect, it } from 'bun:test'

process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.BFF_INTERNAL_URL = 'http://bff.test:37377'
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? ''
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'

const { assertOperatorConsoleEnabled } = await import('../config')

describe('assertOperatorConsoleEnabled', () => {
  it('requires an explicit operator:console grant from the BFF', async () => {
    const disabledFetch = async () => Response.json({ operator_console: false })

    await expect(assertOperatorConsoleEnabled(disabledFetch)).rejects.toThrow(
      'operator:console capability is disabled',
    )
  })

  it('sends the service credential when resolving the capability', async () => {
    const authorizations: Array<string | null> = []
    const enabledFetch = async (_input: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get('authorization'))
      return Response.json({ operator_console: true })
    }

    await assertOperatorConsoleEnabled(enabledFetch)
    expect(authorizations).toEqual(['Bearer fixture-service-credential-alpha'])
  })
})
