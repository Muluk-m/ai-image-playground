import { describe, expect, it, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { logAdminApiError } from '../../../../server/lib/api-error-log'

describe('logAdminApiError', () => {
  it('keeps missing routes as 404 and records one warning without an error stack', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const error = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const app = new Elysia().onError(({ request, error }) => {
        logAdminApiError(request, error)
      })
      const response = await app.handle(
        new Request('http://localhost/api/missing-route?token=private-token', {
          method: 'POST',
          headers: {
            authorization: 'Bearer private-token',
            cookie: 'admin=private-cookie',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ password: 'private-password' }),
        }),
      )
      expect(response.status).toBe(404)
      expect(await response.text()).toBe('NOT_FOUND')
      expect(warn.mock.calls).toEqual([['WARN [admin] POST /api/missing-route failed: NOT_FOUND']])
      expect(error).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      error.mockRestore()
    }
  })

  it('keeps an internal error named NOT_FOUND at error level', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const error = spyOn(console, 'error').mockImplementation(() => {})
    try {
      logAdminApiError(new Request('http://localhost/api/overview'), new Error('NOT_FOUND'))
      expect(warn).not.toHaveBeenCalled()
      expect(error).toHaveBeenCalledTimes(1)
      expect(String(error.mock.calls[0]?.[0])).toContain('GET /api/overview failed: NOT_FOUND')
      expect(String(error.mock.calls[0]?.[0])).toContain('api-error-log.test.ts')
    } finally {
      warn.mockRestore()
      error.mockRestore()
    }
  })

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

  it('logs only the code when the message is the request body', () => {
    const spy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const error = new Error(
        JSON.stringify({
          type: 'validation',
          on: 'body',
          found: { password: 'super-secret-password' },
        }),
      )
      Object.assign(error, { code: 'VALIDATION' })
      logAdminApiError(
        new Request('http://localhost/api/login', {
          method: 'POST',
          body: JSON.stringify({ password: 'super-secret-password' }),
        }),
        error,
      )
      const logged = spy.mock.calls.map((call) => call.map(String).join(' ')).join('\n')
      expect(logged).toContain('POST /api/login failed: VALIDATION')
      expect(logged).not.toContain('super-secret-password')
      expect(logged).not.toContain('found')
    } finally {
      spy.mockRestore()
    }
  })

  it('redacts bearer tokens and API keys that leak into the message or stack', () => {
    const spy = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const error = new Error(
        'upstream failed Bearer sk-abcdefghijklmnopqrstuvwxyz AIzaSyabcdefghijklmnopqrstuvwxyz',
      )
      error.stack = `${error.stack ?? ''}\nhttps://user:pass@upstream.test/callback`
      logAdminApiError(new Request('http://localhost/api/tasks/task-1'), error)
      const logged = spy.mock.calls.map((call) => call.map(String).join(' ')).join('\n')
      expect(logged).toContain('GET /api/tasks/task-1 failed: upstream failed Bearer [REDACTED]')
      expect(logged).toContain('[REDACTED]@upstream.test')
      expect(logged).not.toContain('sk-abcdefghijklmnopqrstuvwxyz')
      expect(logged).not.toContain('AIzaSyabcdefghijklmnopqrstuvwxyz')
      expect(logged).not.toContain('user:pass')
      expect(logged).toContain('api-error-log.test.ts')
    } finally {
      spy.mockRestore()
    }
  })
})
