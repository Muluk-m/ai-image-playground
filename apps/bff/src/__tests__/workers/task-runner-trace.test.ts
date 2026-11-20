import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { SpanKind, SpanStatusCode } from '@opentelemetry/api'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'

process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test-key'
process.env.DATABASE_URL = await resetTestDatabase('bff_task_runner_trace')
installRecordingTaskHooks()
process.env.PORT = '0'

const { close: closeDb, db, schema } = await import('../../db/client')
const { runTask } = await import('../../workers/task-runner')
const { setUpstreamFetchForTesting } = await import('../../lib/upstream')
const { setVertexRateLimitBackoffForTesting } = await import('../../lib/upstream/vertex')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { initTelemetry, shutdownTelemetry } = await import('../../lib/telemetry')
type InternalChannel = import('../../lib/channels').InternalChannel
type TestFetch = NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>

const spans = new InMemorySpanExporter()
initTelemetry('worker', [new SimpleSpanProcessor({ exporter: spans })])

const LITE = 'gemini-3.1-flash-lite-image'
const FALLBACK = 'gemini-nano-banana-2.1'
const BASE = 'https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/google'
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII='

const vertexChannel: InternalChannel = {
  id: 'vertex-images',
  kind: 'gemini-queue',
  label: 'Vertex AI',
  baseUrl: BASE,
  auth: { type: 'bearer', secretRef: 'VERTEX_API_KEY', secret: 'vertex-test-key' },
  allowedPaths: [],
  models: [LITE, FALLBACK].map((id) => ({
    id,
    label: id,
    capabilities: ['generate', 'edit', 'size'],
    imageSizes: ['1K'],
  })),
  defaults: { apiMode: 'images', timeout: 600 },
  modelMaxConcurrency: { [LITE]: 2, [FALLBACK]: 2 },
}

/** 每条上游请求带出去的 traceparent，按发出顺序。 */
let sentTraceparents: Array<string | null> = []

beforeEach(async () => {
  spans.reset()
  sentTraceparents = []
  setObjectStoreForTesting(new InMemoryObjectStore())
  _setChannelsForTesting([vertexChannel])
  setVertexRateLimitBackoffForTesting([1, 1, 1])
  // Lite 一律 429，回落模型出图：一张图走满 3 次退避再回落。
  setUpstreamFetchForTesting((async (input: Parameters<TestFetch>[0], init?: RequestInit) => {
    sentTraceparents.push(new Headers(init?.headers).get('traceparent'))
    if (String(input).includes(`/models/${LITE}:`))
      return Response.json(
        { error: { code: 429, message: 'Resource exhausted.', status: 'RESOURCE_EXHAUSTED' } },
        { status: 429 },
      )
    return Response.json({
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ inlineData: { mimeType: 'image/png', data: TINY_PNG_B64 } }],
          },
          finishReason: 'STOP',
        },
      ],
    })
  }) as unknown as TestFetch)
  await db.delete(schema.tasks)
})

afterEach(() => {
  setUpstreamFetchForTesting()
  setVertexRateLimitBackoffForTesting()
  _setChannelsForTesting([])
  setObjectStoreForTesting()
})

afterAll(async () => {
  await shutdownTelemetry()
  await closeDb()
})

describe('上游请求链路', () => {
  it('每条上游请求一个 CLIENT span 挂在执行 span 下并把 traceparent 带给上游；429 标错，退避记成 event', async () => {
    await db.insert(schema.tasks).values({
      id: 'traced',
      provider: 'gemini',
      model: LITE,
      status: 'queued',
      request_payload: { prompt: 'traced', n: 1 },
      submitted_at: Date.now(),
    })

    await runTask('traced')

    const finished = spans.getFinishedSpans()
    const execution = finished.find((span) => span.name === 'task.execute')
    expect(execution).toBeDefined()
    const upstream = finished.filter((span) => span.kind === SpanKind.CLIENT)
    expect(
      upstream.map((span) => [
        span.attributes['upstream.model'],
        span.attributes['http.response.status_code'],
        span.attributes['upstream.outcome'],
        span.status.code,
      ]),
    ).toEqual([
      ...Array.from({ length: 4 }, () => [LITE, 429, 'http_error', SpanStatusCode.ERROR]),
      [FALLBACK, 200, 'ok', SpanStatusCode.UNSET],
    ])
    for (const span of upstream) {
      expect(span.name).toBe('upstream POST')
      expect(span.spanContext().traceId).toBe(execution!.spanContext().traceId)
      expect(span.parentSpanContext?.spanId).toBe(execution!.spanContext().spanId)
      expect(span.attributes['server.address']).toBe('aiplatform.googleapis.com')
      expect(span.attributes['task.id']).toBe('traced')
      expect(typeof span.attributes['upstream.headers_ms']).toBe('number')
    }
    // 上游收到的 traceparent 指向这条请求自己的 span。
    expect(sentTraceparents).toEqual(
      upstream.map((span) => `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`),
    )
    expect(
      execution!.events
        .filter((event) => event.name === 'upstream.rate_limit_backoff')
        .map((event) => event.attributes?.['upstream.attempt']),
    ).toEqual([1, 2, 3])
  })
})
