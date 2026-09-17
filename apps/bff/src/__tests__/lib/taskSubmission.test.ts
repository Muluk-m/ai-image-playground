import { afterAll, afterEach, beforeEach, expect, it } from 'bun:test'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { SubmitRequest } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import {
  _setPrivateBffOverlayForTesting,
  EMPTY_PRIVATE_BFF_OVERLAY,
} from '../../lib/private-overlay'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test-key'
process.env.DATABASE_URL = await resetTestDatabase('bff_task_submission')
process.env.PORT = '0'
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)

// 动态引入：环境要先钉死，再让捕获配置的模块加载。
const { close, db, schema } = await import('../../db/client')
const { createQueueTask } = await import('../../lib/taskSubmission')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')

// 原尺寸不是 16 的倍数，所以建任务时必须补边；`masked_original_size` 记的是补边前的那个。
const WIDTH = 1001
const HEIGHT = 769
const url = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`
const SOURCE = url(
  await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: '#6386a3' } })
    .png()
    .toBuffer(),
)
const MASK = await (async () => {
  const raw = Buffer.alloc(WIDTH * HEIGHT * 4, 255)
  raw[(390 * WIDTH + 500) * 4 + 3] = 0
  return url(
    await sharp(raw, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } })
      .png()
      .toBuffer(),
  )
})()

let store: InMemoryObjectStore

beforeEach(async () => {
  store = new InMemoryObjectStore()
  setObjectStoreForTesting(store)
  await db.delete(schema.tasks)
})
afterEach(() => {
  setObjectStoreForTesting()
})
afterAll(close)

const AGENT = { conversationId: 'conversation-1', turnId: 'turn-1' } as const

function request(overrides: Partial<SubmitRequest> = {}): Omit<SubmitRequest, 'video'> {
  return {
    prompt: '只改选区里的那一块',
    device_id: 'device-abcdefgh',
    input_images: [SOURCE],
    output_format: 'jpeg',
    output_compression: 80,
    ...overrides,
  }
}

async function submit(input: {
  request: Omit<SubmitRequest, 'video'>
  agent?: typeof AGENT
  video?: { duration_seconds: number; aspect_ratio: '16:9'; resolution: '720p' }
}) {
  const outcome = await createQueueTask({
    provider: 'openai-compat',
    // 自定义尺寸的那一支，原尺寸局部编辑才走得通。
    model: input.video ? 'veo-3.1-fast-generate-preview' : 'gpt-image-2.5-flare',
    request: input.request,
    ...(input.video ? { video: input.video } : {}),
    userId: null,
    ...(input.agent ? { agent: input.agent } : {}),
  })
  expect(outcome.kind).toBe('created')
  if (outcome.kind !== 'created') throw new Error('unreachable')
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, outcome.taskId))
  return task!.request_payload
}

it('marks an agent masked image submission as protected and pads it to the model grid', async () => {
  const payload = await submit({ request: request({ mask: MASK }), agent: AGENT })

  expect(payload.preserve_outside_mask).toBe(true)
  expect(payload.masked_original_size).toEqual({ width: WIDTH, height: HEIGHT })
  // 补边后的像素才是送上游的那一份；交付时按原尺寸裁回去。
  expect(payload.size).toBe('1008x784')
  expect(await sharp(await store.read(payload.input_images![0]!.object)).metadata()).toMatchObject({
    width: 1008,
    height: 784,
  })
  // 保护选区外像素要逐像素比对，有损格式与压缩会把它毁掉。
  expect(payload.output_format).toBe('png')
  expect(payload).not.toHaveProperty('output_compression')
})

it('leaves a plain image submission untouched when nobody drew a selection', async () => {
  const payload = await submit({ request: request(), agent: AGENT })

  expect(payload).not.toHaveProperty('preserve_outside_mask')
  expect(payload).not.toHaveProperty('masked_original_size')
  expect(payload.output_format).toBe('jpeg')
  expect(payload.output_compression).toBe(80)
})

it('does not protect a masked submission that no agent turn owns', async () => {
  const payload = await submit({ request: request({ mask: MASK }) })

  expect(payload).not.toHaveProperty('preserve_outside_mask')
  expect(payload).not.toHaveProperty('masked_original_size')
  expect(payload.output_format).toBe('jpeg')
  expect(payload.mask).toBeDefined()
})

it('does not protect a video submission even when the agent turn carries a mask', async () => {
  const payload = await submit({
    request: request({ mask: MASK }),
    agent: AGENT,
    video: { duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p' },
  })

  expect(payload).not.toHaveProperty('preserve_outside_mask')
  expect(payload).not.toHaveProperty('masked_original_size')
  expect(payload.video).toMatchObject({ duration_seconds: 5, resolution: '720p' })
})
