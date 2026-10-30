import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import {
  _setPrivateBffOverlayForTesting,
  EMPTY_PRIVATE_BFF_OVERLAY,
} from '../../lib/private-overlay'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test-key'
process.env.DATABASE_URL = await resetTestDatabase('bff_task_runner_rate_limit')
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)
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
/** 列在 `throttled` 里的模型一律 429，其余一律出图。 */
function vertex(throttled: readonly string[]) {
  calls = []
  setUpstreamFetchForTesting((async (input: Parameters<TestFetch>[0]) => {
    const url = String(input)
    calls.push(url)
    if (throttled.some((model) => url.includes(`/models/${model}:`)))
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

async function insertLiteTask(id: string, n: number) {
  await db.insert(schema.tasks).values({
    id,
    provider: 'gemini',
    model: LITE,
    status: 'queued',
    request_payload: { prompt: id, n },
    submitted_at: 1,
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
})
