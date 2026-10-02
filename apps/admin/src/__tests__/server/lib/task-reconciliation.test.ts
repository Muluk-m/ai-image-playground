import { afterEach, expect, it, spyOn } from 'bun:test'

process.env.ADMIN_PASSWORD = 'fixture'
process.env.ADMIN_COOKIE_SECRET = 'fixture-reconciliation-cookie-secret'
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost/test'
process.env.INTERNAL_API_TOKEN = 'fixture-service-token'
process.env.PORT = '0'
const { forwardTaskReconciliation } = await import('../../../../server/lib/task-reconciliation')
const mocks: { mockRestore(): void }[] = []
afterEach(() => {
  for (const mock of mocks.splice(0)) mock.mockRestore()
})

it('bounds a stalled reconciliation command and reports an uncertain outcome with the original command ID', async () => {
  mocks.push(
    spyOn(AbortSignal, 'timeout').mockImplementation(() =>
      AbortSignal.abort(new DOMException('timed out', 'TimeoutError')),
    ),
  )
  mocks.push(
    spyOn(globalThis, 'fetch').mockImplementation(
      Object.assign(
        async (_input: RequestInfo | URL, init?: RequestInit) => {
          if (!init?.signal) throw new Error('missing bounded request signal')
          init.signal.throwIfAborted()
          return Response.json({})
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    ),
  )
  const response = await forwardTaskReconciliation('task-1', {
    commandId: 'same-command',
    action: 'lookup',
    evidence: 'provider case',
  })
  expect(response.status).toBe(504)
  expect(await response.json()).toMatchObject({
    error: 'reconciliation_result_uncertain',
    commandId: 'same-command',
  })
})
