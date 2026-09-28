import { describe, expect, it } from 'bun:test'
import { REQUEST_ID_HEADER, requestLogFields, withRequestContext } from '../../lib/request-context'

function handlerRecordingLogFields(seen: unknown[]) {
  return withRequestContext(async () => {
    await Bun.sleep(1)
    seen.push(requestLogFields())
    return new Response('ok')
  })
}

describe('request context', () => {
  it('gives each request an id, puts it on every log line inside it and returns it', async () => {
    const seen: unknown[] = []
    const handle = handlerRecordingLogFields(seen)
    const [a, b] = await Promise.all([
      handle(new Request('http://localhost/api/a')),
      handle(new Request('http://localhost/api/b')),
    ])
    const ids = [a.headers.get(REQUEST_ID_HEADER), b.headers.get(REQUEST_ID_HEADER)]
    expect(ids[0]).toBeTruthy()
    expect(ids[0]).not.toBe(ids[1])
    expect(seen).toEqual(expect.arrayContaining(ids.map((requestId) => ({ requestId }))))
  })

  it('keeps a well-formed id from the caller and replaces anything else', async () => {
    const seen: unknown[] = []
    const handle = handlerRecordingLogFields(seen)
    const kept = await handle(
      new Request('http://localhost/api/a', { headers: { [REQUEST_ID_HEADER]: 'edge-7f3a9c21' } }),
    )
    expect(kept.headers.get(REQUEST_ID_HEADER)).toBe('edge-7f3a9c21')

    for (const bad of ['short', 'has spaces in it', 'x'.repeat(200), '<script>alert(1)</script>']) {
      const replaced = await handle(
        new Request('http://localhost/api/a', { headers: { [REQUEST_ID_HEADER]: bad } }),
      )
      expect(replaced.headers.get(REQUEST_ID_HEADER)).not.toBe(bad)
    }
  })

  it('logs nothing extra outside a request', () => {
    expect(requestLogFields()).toEqual({})
  })
})
