import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace'
import { withRequestContext } from '../../lib/request-context'
import { initTelemetry, shutdownTelemetry, traceLogFields } from '../../lib/telemetry'

const exporter = new InMemorySpanExporter()
initTelemetry('bff', [new SimpleSpanProcessor({ exporter })])

afterAll(async () => {
  await shutdownTelemetry()
})

beforeEach(() => {
  exporter.reset()
})

const PARENT_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736'
const PARENT_SPAN = '00f067aa0ba902b7'

describe('HTTP 服务端 span', () => {
  it('接着调用方的 traceparent，请求里的日志带同一个 trace_id，跨 await 不丢', async () => {
    const seen: unknown[] = []
    const handle = withRequestContext(async () => {
      await Bun.sleep(1)
      seen.push(traceLogFields())
      return new Response('ok', { status: 201 })
    })
    await handle(
      new Request('http://localhost/api/tasks', {
        method: 'POST',
        headers: { traceparent: `00-${PARENT_TRACE}-${PARENT_SPAN}-01` },
      }),
    )
    const [span] = exporter.getFinishedSpans()
    expect(span?.kind).toBe(SpanKind.SERVER)
    expect(span?.spanContext().traceId).toBe(PARENT_TRACE)
    expect(span?.parentSpanContext?.spanId).toBe(PARENT_SPAN)
    expect(span?.attributes['http.response.status_code']).toBe(201)
    expect(span?.attributes['url.path']).toBe('/api/tasks')
    expect(seen).toEqual([{ trace_id: PARENT_TRACE, span_id: span?.spanContext().spanId }])
  })

  it('没有 traceparent 时开新的 trace；并发请求互不串号', async () => {
    const seen: Array<{ trace_id?: string }> = []
    const handle = withRequestContext(async () => {
      await Bun.sleep(2)
      seen.push(traceLogFields())
      return new Response('ok')
    })
    await Promise.all([
      handle(new Request('http://localhost/api/a')),
      handle(new Request('http://localhost/api/b')),
    ])
    const traces = exporter.getFinishedSpans().map((span) => span.spanContext().traceId)
    expect(new Set(traces).size).toBe(2)
    expect(seen.map((fields) => fields.trace_id).sort()).toEqual([...traces].sort())
  })

  it('5xx 与抛错都把 span 标成错误；抛错照原样往外抛', async () => {
    await withRequestContext(async () => new Response('down', { status: 503 }))(
      new Request('http://localhost/api/x'),
    )
    const failing = withRequestContext(async () => {
      throw new Error('boom')
    })
    await expect(failing(new Request('http://localhost/api/y'))).rejects.toThrow('boom')
    const statuses = exporter.getFinishedSpans().map((span) => span.status.code)
    expect(statuses).toEqual([SpanStatusCode.ERROR, SpanStatusCode.ERROR])
  })

  it('不在任何 span 里时不写 trace 字段', () => {
    expect(traceLogFields()).toEqual({})
  })
})
