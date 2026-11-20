import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetTraceContextForTesting,
  attachTraceparent,
  isTraceId,
  newTraceId,
  noteFailedTrace,
  recentFailedTraceId,
  requiresPreflight,
  responseTraceId,
  traceparentFor,
} from '../../lib/traceContext'

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'

afterEach(() => {
  vi.unstubAllGlobals()
  _resetTraceContextForTesting()
})

describe('trace context', () => {
  it('builds W3C traceparent values: same trace, a fresh span per send', () => {
    const traceId = newTraceId()
    expect(isTraceId(traceId)).toBe(true)
    const [a, b] = [traceparentFor(traceId), traceparentFor(traceId)]
    expect(a).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`))
    expect(a.split('-')[2]).not.toBe(b.split('-')[2])
    expect(isTraceId('0'.repeat(32))).toBe(false)
    expect(isTraceId(TRACE.toUpperCase())).toBe(false)
  })

  it('only treats requests that already need a CORS preflight as preflighted', () => {
    expect(requiresPreflight({})).toBe(false)
    expect(requiresPreflight({ method: 'POST', body: new FormData() })).toBe(false)
    expect(requiresPreflight({ method: 'POST', body: 'x' })).toBe(false)
    expect(
      requiresPreflight({
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
      }),
    ).toBe(false)
    expect(
      requiresPreflight({ method: 'POST', headers: { 'Content-Type': 'application/json' } }),
    ).toBe(true)
    expect(requiresPreflight({ method: 'DELETE' })).toBe(true)
    expect(requiresPreflight({ method: 'patch' })).toBe(true)
    expect(requiresPreflight({ headers: { 'idempotency-key': 'k' } })).toBe(true)
    // 没写 content-type 时浏览器按 Blob 自己的类型补，image/png 不在安全列表里。
    expect(
      requiresPreflight({ method: 'POST', body: new Blob(['x'], { type: 'image/png' }) }),
    ).toBe(true)
    expect(
      requiresPreflight({
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Blob(['x'], { type: 'text/plain' }),
      }),
    ).toBe(true)
  })

  it('does not turn a simple cross-origin request into a preflighted one', () => {
    vi.stubGlobal('location', new URL('https://app.example.com/projects'))
    const init = { credentials: 'include' as const }
    expect(attachTraceparent('https://api.example.com/api/projects', init, TRACE)).toEqual({
      init,
      traceId: null,
    })

    const json = attachTraceparent(
      'https://api.example.com/api/tasks',
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      TRACE,
    )
    expect(json.traceId).toBe(TRACE)
    const headers = new Headers(json.init.headers)
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('traceparent')).toMatch(new RegExp(`^00-${TRACE}-`))
  })

  it('always traces same-origin requests, which never preflight', () => {
    vi.stubGlobal('location', new URL('https://app.example.com/projects'))
    for (const input of ['/api/projects', 'https://app.example.com/api/projects']) {
      const traced = attachTraceparent(input, {}, TRACE)
      expect(traced.traceId).toBe(TRACE)
      expect(new Headers(traced.init.headers).has('traceparent')).toBe(true)
    }
  })

  it('remembers the last failed trace for 15 seconds, preferring the server-reported id', () => {
    const served = '0af7651916cd43dd8448eb211c80319c'
    const response = new Response(null, { status: 500, headers: { 'x-trace-id': served } })
    expect(responseTraceId(response, TRACE)).toBe(served)
    expect(responseTraceId(new Response(null, { headers: { 'x-trace-id': 'junk' } }), TRACE)).toBe(
      TRACE,
    )

    noteFailedTrace(served, 1_000)
    expect(recentFailedTraceId(16_000)).toBe(served)
    expect(recentFailedTraceId(16_001)).toBeUndefined()
    noteFailedTrace(null, 20_000)
    noteFailedTrace('nope', 20_000)
    expect(recentFailedTraceId(20_000)).toBeUndefined()
  })
})
