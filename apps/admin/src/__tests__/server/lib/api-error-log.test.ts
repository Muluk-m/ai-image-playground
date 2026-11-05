import { describe, expect, it, spyOn } from 'bun:test'
import { logAdminApiError } from '../../../../server/lib/api-error-log'

describe('logAdminApiError', () => {
  it('records the route, message, and stack, and leaves the body and secrets out', () => {
    const spy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const error = new Error('invalid input syntax for type integer: "gif"')
      logAdminApiError(
        new Request('http://admin.muvloom.online/api/overview?from=1&to=2&token=sk-live-secret', {
          method: 'GET',
          headers: { authorization: 'Bearer sk-live-secret', cookie: 'admin=secret-cookie' },
        }),
        error,
      )
      const logged = spy.mock.calls.map((call) => call.map(String).join(' ')).join('\n')
      expect(logged).toContain('GET /api/overview failed: invalid input syntax for type integer')
      expect(logged).toContain('api-error-log.test.ts')
      expect(logged).not.toContain('sk-live-secret')
      expect(logged).not.toContain('secret-cookie')
      expect(logged).not.toContain('from=1')
      expect(logged).not.toContain('token=')
    } finally {
      spy.mockRestore()
    }
  })
})
