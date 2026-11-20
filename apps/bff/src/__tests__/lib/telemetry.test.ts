import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace'
import { withRequestContext } from '../../lib/request-context'
import {
  currentTraceparent,
  initTelemetry,
  recordSpanError,
  recordTaskOutcome,
  runInLinkedSpan,
  shutdownTelemetry,
  traceLogFields,
  tracer,
  withTraceHeaders,
} from '../../lib/telemetry'

delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
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

  it('健康检查、内部接口与静态资源不建 span，但 request id 照常返回', async () => {
    const handle = withRequestContext(async () => new Response('ok'))
    const responses = await Promise.all(
      ['/health', '/internal/logs/ingest', '/assets/app.js'].map((path) =>
        handle(new Request(`http://localhost${path}`)),
      ),
    )
    expect(exporter.getFinishedSpans()).toEqual([])
    expect(responses.every((response) => response.headers.get('x-request-id'))).toBe(true)
  })

  it('调用方 traceparent 标了不采样也照样记录，调用方关不掉我们的链路', async () => {
    await withRequestContext(async () => new Response('ok'))(
      new Request('http://localhost/api/a', {
        headers: { traceparent: `00-${PARENT_TRACE}-${PARENT_SPAN}-00` },
      }),
    )
    const [span] = exporter.getFinishedSpans()
    expect(span?.spanContext().traceId).toBe(PARENT_TRACE)
  })

  it('异常写进 span 前脱敏，不带堆栈', async () => {
    const failing = withRequestContext(async () => {
      throw new Error('upstream failed: Authorization: Bearer sk-live-abcdefghijklmnop1234')
    })
    await expect(failing(new Request('http://localhost/api/z'))).rejects.toThrow()
    const [event] = exporter.getFinishedSpans()[0]?.events ?? []
    const message = String(event?.attributes?.['exception.message'])
    expect(message).not.toContain('sk-live-abcdefghijklmnop1234')
    expect(event?.attributes?.['exception.stacktrace']).toBeUndefined()
  })

  it('不在任何 span 里时不写 trace 字段', () => {
    expect(traceLogFields()).toEqual({})
  })
})

describe('任务跨进程链路', () => {
  it('提交请求里取到的 traceparent 属于这次请求的链路；不在 span 里时为 null', async () => {
    let seen: string | null = null
    await withRequestContext(async () => {
      seen = currentTraceparent()
      return new Response('ok')
    })(
      new Request('http://localhost/api/tasks', {
        method: 'POST',
        headers: { traceparent: `00-${PARENT_TRACE}-${PARENT_SPAN}-01` },
      }),
    )
    expect(seen).toStartWith(`00-${PARENT_TRACE}-`)
    expect(currentTraceparent()).toBeNull()
  })

  it('worker 执行开新 trace，用 link 指回提交链路，里面的日志带新 trace_id', async () => {
    let fields: { trace_id?: string } = {}
    await runInLinkedSpan(
      'task.execute',
      `00-${PARENT_TRACE}-${PARENT_SPAN}-01`,
      { 'task.id': 't1' },
      async () => {
        await Bun.sleep(1)
        fields = traceLogFields()
      },
    )
    const [span] = exporter.getFinishedSpans()
    expect(span?.name).toBe('task.execute')
    expect(span?.spanContext().traceId).not.toBe(PARENT_TRACE)
    expect(span?.parentSpanContext).toBeUndefined()
    expect(span?.links.map((link) => link.context.traceId)).toEqual([PARENT_TRACE])
    expect(span?.attributes['task.id']).toBe('t1')
    expect(fields.trace_id).toBe(span?.spanContext().traceId)
  })

  it('旧任务没有 traceparent、或值不合法时照样执行，只是没有 link', async () => {
    await runInLinkedSpan('task.execute', null, {}, async () => {})
    await runInLinkedSpan('task.execute', 'garbage', {}, async () => {})
    expect(exporter.getFinishedSpans().map((span) => span.links.length)).toEqual([0, 0])
  })

  it('执行抛错时 span 标错误、信息脱敏，错误照原样往外抛', async () => {
    await expect(
      runInLinkedSpan('task.execute', null, {}, async () => {
        throw new Error('key=sk-live-abcdefghijklmnop1234 rejected')
      }),
    ).rejects.toThrow('rejected')
    const [span] = exporter.getFinishedSpans()
    expect(span?.status.code).toBe(SpanStatusCode.ERROR)
    expect(String(span?.events[0]?.attributes?.['exception.message'])).not.toContain(
      'sk-live-abcdefghijklmnop1234',
    )
  })
})

describe('执行结果', () => {
  it('失败类结果标错误，完成与取消不标；不在 span 里时什么也不做', async () => {
    for (const outcome of ['completed', 'cancelled', 'retry_scheduled', 'reconciling'] as const)
      await runInLinkedSpan('task.execute', null, {}, async () => recordTaskOutcome(outcome))
    expect(
      exporter
        .getFinishedSpans()
        .map((span) => [span.attributes['task.outcome'], span.status.code]),
    ).toEqual([
      ['completed', SpanStatusCode.UNSET],
      ['cancelled', SpanStatusCode.UNSET],
      ['retry_scheduled', SpanStatusCode.ERROR],
      ['reconciling', SpanStatusCode.ERROR],
    ])
    expect(() => recordTaskOutcome('failed', 'x')).not.toThrow()
  })
})

describe('出口 span 工具', () => {
  it('异常写进 span 时地址只留主机名：查询串里的签名、key 和路径里的对象 key 都去掉', () => {
    const span = tracer.startSpan('r2 write')
    recordSpanError(
      span,
      new TypeError(
        'fetch failed: https://r2.example.test/paid/user-1/task-9/0.png?X-Amz-Signature=s1 and https://g.example/v1/m:generate?key=k1',
      ),
    )
    span.end()
    const [finished] = exporter.getFinishedSpans()
    const message = String(finished?.events[0]?.attributes?.['exception.message'])
    expect(message).toBe(
      'fetch failed: https://r2.example.test/<redacted> and https://g.example/<redacted>',
    )
    expect(finished?.events[0]?.attributes?.['exception.type']).toBe('TypeError')
    expect(finished?.status.code).toBe(SpanStatusCode.ERROR)
  })

  it('traceparent 注入不改调用方的 headers；几种写法都认，已有的同名头（任何大小写）被覆盖', () => {
    const span = tracer.startSpan('upstream POST')
    const expected = `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`
    const stale = '00-11111111111111111111111111111111-2222222222222222-01'
    const injected = (headers: unknown) => withTraceHeaders(headers, span) as Headers

    const record = { authorization: 'Bearer x', Traceparent: stale }
    expect(injected(record).get('traceparent')).toBe(expected)
    expect(injected(record).get('authorization')).toBe('Bearer x')
    expect(record).toEqual({ authorization: 'Bearer x', Traceparent: stale })

    const headers = new Headers({ authorization: 'Bearer x' })
    expect(injected(headers).get('traceparent')).toBe(expected)
    expect(headers.has('traceparent')).toBe(false)

    const pairs: [string, string][] = [
      ['authorization', 'Bearer x'],
      ['traceparent', stale],
    ]
    expect(injected(pairs).get('traceparent')).toBe(expected)
    expect(injected(undefined).get('traceparent')).toBe(expected)
    span.end()
  })
})
