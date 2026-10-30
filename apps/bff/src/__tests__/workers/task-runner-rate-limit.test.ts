import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'

process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test-key'
process.env.DATABASE_URL = await resetTestDatabase('bff_task_runner_rate_limit')
// 部分出图按交付张数结算：记下结算时带给账本的实际用量。
const hooks = installRecordingTaskHooks()
process.env.PORT = '0'

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { close: closeDb, db, schema } = await import('../../db/client')
const { runTask } = await import('../../workers/task-runner')
const { setUpstreamFetchForTesting } = await import('../../lib/upstream')
const { setVertexRateLimitBackoffForTesting } = await import('../../lib/upstream/vertex')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
type InternalChannel = import('../../lib/channels').InternalChannel
type TestFetch = NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>

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

let calls: string[] = []
/** 列在 `throttled` 里的模型一律 429，其余一律出图；`spare` 条请求不管模型先放行。 */
function vertex(throttled: readonly string[], spare = 0) {
  calls = []
  setUpstreamFetchForTesting((async (input: Parameters<TestFetch>[0]) => {
    const url = String(input)
    calls.push(url)
    if (calls.length > spare && throttled.some((model) => url.includes(`/models/${model}:`)))
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
}

beforeEach(async () => {
  setObjectStoreForTesting(new InMemoryObjectStore())
  _setChannelsForTesting([vertexChannel])
  setVertexRateLimitBackoffForTesting([1, 1, 1])
  await db.delete(schema.tasks)
  hooks.reset()
})

afterEach(() => {
  setUpstreamFetchForTesting()
  setVertexRateLimitBackoffForTesting()
  _setChannelsForTesting([])
  setObjectStoreForTesting()
})

afterAll(async () => {
  await closeDb()
})

async function insertLiteTask(id: string, n: number, submittedAt = Date.now()) {
  await db.insert(schema.tasks).values({
    id,
    provider: 'gemini',
    model: LITE,
    status: 'queued',
    request_payload: { prompt: id, n },
    submitted_at: submittedAt,
  })
}

async function readTask(id: string) {
  const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id))
  return row!
}

describe('Lite 限流（2026-10-29）', () => {
  it('delivers a throttled Lite order in full from the fallback model and records the swap', async () => {
    vertex([LITE])
    await insertLiteTask('lite-fallback', 4)

    await runTask('lite-fallback')

    const task = await readTask('lite-fallback')
    expect(task.status).toBe('completed')
    expect(task.error_type).toBeNull()
    // 每张：原模型 1 次 + 3 次退避，再回落 1 次；每次真实请求都记账。
    expect(task.upstream_invocation_count).toBe(4 * 5)
    expect(calls.filter((url) => url.includes(`/models/${FALLBACK}:`))).toHaveLength(4)
    // 记在结果里，对账与统计看得到哪几张是回落模型出的；结算仍按任务自己的模型。
    expect((task.result_payload as Record<string, unknown>).model_fallback).toEqual({
      requested_model: LITE,
      model: FALLBACK,
      images: 4,
    })
    expect(task.model).toBe(LITE)
  })

  it('classifies a final 429 as rate_limited and does not rerun the order', async () => {
    vertex([LITE, FALLBACK])
    await insertLiteTask('lite-throttled', 2)

    await runTask('lite-throttled')

    const task = await readTask('lite-throttled')
    expect(task.status).toBe('failed')
    expect(task.error_type).toBe('rate_limited')
    // 整单不再重跑：每张原模型 4 次、回落 4 次，之后就停，不会再来一整轮。
    expect(task.upstream_invocation_count).toBe(2 * 8)
    expect(calls).toHaveLength(2 * 8)
  })

  it('delivers the images that came back and settles only for those', async () => {
    // 第一条请求出图，其余（含回落）一律 429：3 张里交付 1 张，不整单失败。
    vertex([LITE, FALLBACK], 1)
    await insertLiteTask('lite-partial', 3)

    await runTask('lite-partial')

    const task = await readTask('lite-partial')
    expect(task.status).toBe('completed')
    expect(task.error_type).toBeNull()
    expect((task.result_payload as Record<string, unknown>).partial_failure).toEqual({
      requested: 3,
      failed: 2,
      type: 'rate_limited',
    })
    expect(hooks.settlements).toEqual([
      expect.objectContaining({
        taskId: 'lite-partial',
        outcome: 'completed',
        actualUsage: { quantity: 1, unitMultiplier: 1 },
      }),
    ])
  })

  describe('原模型总时限（从提交算起，含排队）', () => {
    const PAST_CAP = () => Date.now() - 60 * 60 * 1000

    it('sends an order already past the cap straight to the fallback model', async () => {
      vertex([LITE])
      await insertLiteTask('lite-capped', 2, PAST_CAP())

      await runTask('lite-capped')

      const task = await readTask('lite-capped')
      expect(task.status).toBe('completed')
      expect(calls.every((url) => url.includes(`/models/${FALLBACK}:`))).toBe(true)
      expect(calls).toHaveLength(2)
      expect((task.result_payload as Record<string, unknown>).model_fallback).toEqual({
        requested_model: LITE,
        model: FALLBACK,
        images: 2,
      })
    })

    it('fails the order without a rerun when the fallback errors after the cap', async () => {
      calls = []
      setUpstreamFetchForTesting((async (input: Parameters<TestFetch>[0]) => {
        calls.push(String(input))
        return Response.json(
          { error: { code: 503, message: 'Service unavailable.', status: 'UNAVAILABLE' } },
          { status: 503 },
        )
      }) as unknown as TestFetch)
      await insertLiteTask('lite-capped-fail', 1, PAST_CAP())

      await runTask('lite-capped-fail')

      const task = await readTask('lite-capped-fail')
      // 503 平时会排一次任务级重试；过了总时限就是终态。
      expect(task.status).toBe('failed')
      expect(task.next_retry_at).toBeNull()
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain(`/models/${FALLBACK}:`)
    })
  })
})
