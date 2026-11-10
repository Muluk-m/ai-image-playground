import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
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
const { config } = await import('../../config')
const { createQueueTask, submitPrepared } = await import('../../lib/taskSubmission')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
// 数据库测试的模块加载边界：静态 import 会在上面的独立 DATABASE_URL 与 overlay 注入前捕获单例。
const { quoteBatchPlan } = await import('../../lib/agent/batch-plans')

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
  _setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)
})
afterEach(() => {
  setObjectStoreForTesting()
})

const BILLING_USER = '4k-billing-user'
async function ensureBillingUser() {
  await db
    .insert(schema.users)
    .values({
      id: BILLING_USER,
      username: BILLING_USER,
      password_hash: 'fixture',
      created_at: Date.now(),
      updated_at: Date.now(),
    })
    .onConflictDoNothing()
}

async function submit4k(userId: string | null = BILLING_USER) {
  return createQueueTask({
    entry: 'web-direct',
    provider: 'openai-compat',
    model: 'gpt-image-2.5-flare',
    request: request({ image_size: '4K', input_images: undefined }),
    userId,
  })
}
it('persists original prompt facts while queueing the prompt', async () => {
  const originalPrompt = 'a red cat'
  const outcome = await createQueueTask({
    entry: 'web-direct',
    provider: 'openai-compat',
    model: 'gpt-image-2.5-flare',
    promptShaping: { originalPrompt },
    request: request({ prompt: originalPrompt, size: '1280x720' }),
    userId: null,
  })
  expect(outcome.kind).toBe('created')
  if (outcome.kind !== 'created') throw new Error('unreachable')
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, outcome.taskId))
  expect(task!.request_payload.prompt).toBe(originalPrompt)
  expect(task!.request_payload.prompt_shaping).toMatchObject({
    original_prompt: originalPrompt,
    ratio_via_prompt: false,
  })
})

it('accepts 4K with a current active private billing subscription', async () => {
  await ensureBillingUser()
  _setPrivateBffOverlayForTesting({
    ...EMPTY_PRIVATE_BFF_OVERLAY,
    present: true,
    taskHooks: { ...EMPTY_PRIVATE_BFF_OVERLAY.taskHooks, canSubmitTask: async () => true },
  })
  expect((await submit4k()).kind).toBe('created')
})

it('denies ended subscriptions before creating a task or hold', async () => {
  await ensureBillingUser()
  _setPrivateBffOverlayForTesting({
    ...EMPTY_PRIVATE_BFF_OVERLAY,
    present: true,
    taskHooks: { ...EMPTY_PRIVATE_BFF_OVERLAY.taskHooks, canSubmitTask: async () => false },
  })
  expect((await submit4k()).kind).toBe('private_billing_denied')
  expect(await db.select().from(schema.tasks)).toHaveLength(0)
})

it('rejects a 768×16 GIF before creating a task or invoking billing', async () => {
  const enabled = config.gptImage26.enabled
  const apiKey = process.env.OPENAI_API_KEY
  config.gptImage26.enabled = true
  process.env.OPENAI_API_KEY = 'gif-test-key'
  let billingCalled = false
  _setPrivateBffOverlayForTesting({
    ...EMPTY_PRIVATE_BFF_OVERLAY,
    present: true,
    taskHooks: {
      ...EMPTY_PRIVATE_BFF_OVERLAY.taskHooks,
      canSubmitTask: async () => {
        billingCalled = true
        return true
      },
    },
  })
  try {
    const result = await createQueueTask({
      entry: 'web-direct',
      provider: 'openai-compat',
      model: 'gpt-image-2.6-flare',
      userId: null,
      request: {
        prompt: 'A bouncing ball',
        device_id: 'gif-limit',
        output_format: 'gif',
        size: '768x768',
        frame_count: 16,
        frame_duration_ms: 300,
        quality: 'medium',
        n: 1,
      },
    })
    expect(result).toMatchObject({
      kind: 'invalid_image_request',
      code: 'gif_sprite',
      fields: ['size', 'frame_count'],
    })
    expect(billingCalled).toBe(false)
    expect(await db.select().from(schema.tasks)).toEqual([])
  } finally {
    config.gptImage26.enabled = enabled
    if (apiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = apiKey
    _setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)
  }
})

it('accepts a GIF that omits the frame defaults shown in the settings control', async () => {
  const enabled = config.gptImage26.enabled
  const apiKey = process.env.OPENAI_API_KEY
  config.gptImage26.enabled = true
  process.env.OPENAI_API_KEY = 'gif-test-key'
  try {
    const result = await createQueueTask({
      entry: 'web-direct',
      provider: 'openai-compat',
      model: 'gpt-image-2.6-flare',
      userId: null,
      request: {
        prompt: 'A bouncing ball',
        device_id: 'gif-default',
        output_format: 'gif',
        size: '768x768',
        quality: 'medium',
        n: 1,
      },
    })
    expect(result.kind).toBe('created')
    if (result.kind !== 'created') return
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, result.taskId))
    expect(task?.request_payload).toMatchObject({
      output_format: 'gif',
      size: '768x768',
      frame_count: 6,
      frame_duration_ms: 200,
      quality: 'medium',
      n: 1,
    })
  } finally {
    config.gptImage26.enabled = enabled
    if (apiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = apiKey
  }
})

it('keeps an explicit 12-frame GIF instead of filling the 6-frame default', async () => {
  const enabled = config.gptImage26.enabled
  const apiKey = process.env.OPENAI_API_KEY
  config.gptImage26.enabled = true
  process.env.OPENAI_API_KEY = 'gif-test-key'
  try {
    const result = await createQueueTask({
      entry: 'agent',
      provider: 'openai-compat',
      model: 'gpt-image-2.6-flare',
      userId: null,
      request: {
        prompt: 'A bouncing ball',
        device_id: 'gif-twelve',
        output_format: 'gif',
        size: '768x768',
        quality: 'medium',
        frame_count: 12,
        frame_duration_ms: 100,
        n: 1,
      },
    })
    expect(result.kind).toBe('created')
    if (result.kind !== 'created') return
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, result.taskId))
    expect(task?.request_payload).toMatchObject({ frame_count: 12, frame_duration_ms: 100 })
  } finally {
    config.gptImage26.enabled = enabled
    if (apiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = apiKey
  }
})

it('accepts a still 2K high-quality Image 2.6 request without rewriting it', async () => {
  const enabled = config.gptImage26.enabled
  const apiKey = process.env.OPENAI_API_KEY
  config.gptImage26.enabled = true
  process.env.OPENAI_API_KEY = 'still-test-key'
  try {
    const result = await createQueueTask({
      entry: 'web-direct',
      provider: 'openai-compat',
      model: 'gpt-image-2.6-flare',
      userId: null,
      request: {
        prompt: 'A red paper crane',
        device_id: 'still-2k',
        output_format: 'png',
        size: '2560x1440',
        quality: 'high',
        n: 1,
      },
    })
    expect(result.kind).toBe('created')
    if (result.kind !== 'created') return
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, result.taskId))
    expect(task?.request_payload).toMatchObject({
      size: '2560x1440',
      quality: 'high',
      output_format: 'png',
    })
  } finally {
    config.gptImage26.enabled = enabled
    if (apiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = apiKey
  }
})

it('denies 4K by default when the private billing hook is missing', async () => {
  await ensureBillingUser()
  _setPrivateBffOverlayForTesting({ ...EMPTY_PRIVATE_BFF_OVERLAY, present: true })
  expect((await submit4k()).kind).toBe('private_billing_denied')
  expect(await db.select().from(schema.tasks)).toHaveLength(0)
})

describe('non-member resolution ceiling', () => {
  const direct = { enabled: process.env.GPT_DIRECT_ENABLED, apiKey: process.env.OPENAI_API_KEY }

  beforeEach(() => {
    process.env.GPT_DIRECT_ENABLED = 'true'
    process.env.OPENAI_API_KEY = 'direct-key'
  })
  afterEach(() => {
    if (direct.enabled === undefined) delete process.env.GPT_DIRECT_ENABLED
    else process.env.GPT_DIRECT_ENABLED = direct.enabled
    if (direct.apiKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = direct.apiKey
  })

  function withMember(member: boolean, onLookup?: () => void) {
    _setPrivateBffOverlayForTesting({
      ...EMPTY_PRIVATE_BFF_OVERLAY,
      present: true,
      taskHooks: {
        ...EMPTY_PRIVATE_BFF_OVERLAY.taskHooks,
        canSubmitTask: async () => member,
        isActiveMember: async () => {
          onLookup?.()
          return member
        },
      },
    })
  }

  /** 走预先准备的路径提交一条；`between` 在归档之后、提交之前执行。 */
  async function submitPreparedOnce(
    input: Parameters<typeof createQueueTask>[0],
    between?: () => void,
  ) {
    const result = await submitPrepared([input], (_tx, submit) => {
      between?.()
      return submit(0)
    })
    if (result.kind !== 'committed') throw new Error(`prepare refused: ${result.outcome.kind}`)
    return result.value
  }

  async function storedRequest(outcome: Awaited<ReturnType<typeof createQueueTask>>) {
    expect(outcome.kind).toBe('created')
    if (outcome.kind !== 'created') throw new Error('expected a task')
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, outcome.taskId))
    return task!.request_payload
  }

  it.each([
    '3840x2160',
    '2880x2880',
    '2160x3840',
    '3456x2304',
  ])('downgrades a non-member website %s request to 2K and medium', async (size) => {
    await ensureBillingUser()
    withMember(false)
    const payload = await storedRequest(
      await createQueueTask({
        entry: 'web-direct',
        provider: 'openai-compat',
        model: 'gpt-image-2.5-flare',
        userId: BILLING_USER,
        request: request({ size, quality: 'high', input_images: undefined }),
      }),
    )
    expect(payload.quality).toBe('medium')
    expect(payload.size).not.toBe(size)
    const [width, height] = payload.size!.split('x').map(Number)
    expect(width! * height!).toBeLessThanOrEqual(4_194_304)
    expect(width! % 16).toBe(0)
    expect(height! % 16).toBe(0)
  })

  it('leaves a member 4K high request unchanged', async () => {
    await ensureBillingUser()
    withMember(true)
    const payload = await storedRequest(
      await createQueueTask({
        entry: 'web-direct',
        provider: 'openai-compat',
        model: 'gpt-image-2.5-flare',
        userId: BILLING_USER,
        request: request({ size: '3840x2160', quality: 'high', input_images: undefined }),
      }),
    )
    expect(payload).toMatchObject({ size: '3840x2160', quality: 'high' })
  })

  it('rejects a strict non-member 4K or high request and accepts 2K', async () => {
    await ensureBillingUser()
    withMember(false)
    for (const extra of [{ size: '3840x2160' }, { size: '1024x1024', quality: 'high' as const }]) {
      const denied = await createQueueTask({
        entry: 'cli-strict',
        provider: 'openai-compat',
        model: 'gpt-image-2.5-flare',
        userId: BILLING_USER,
        strictImageRequest: true,
        request: request({ ...extra, input_images: undefined }),
      })
      expect(denied.kind).toBe('private_billing_denied')
    }
    const allowed = await storedRequest(
      await createQueueTask({
        entry: 'cli-strict',
        provider: 'openai-compat',
        model: 'gpt-image-2.5-flare',
        userId: BILLING_USER,
        strictImageRequest: true,
        request: request({ size: '2560x1440', quality: 'medium', input_images: undefined }),
      }),
    )
    expect(allowed).toMatchObject({ size: '2560x1440', quality: 'medium' })
    expect(await db.select().from(schema.tasks)).toHaveLength(1)
  })

  it('downgrades a non-member Gemini 4K submission to 2K and rejects the same request from the CLI', async () => {
    await ensureBillingUser()
    withMember(false)
    const website = await storedRequest(
      await createQueueTask({
        entry: 'web-direct',
        provider: 'gemini',
        model: 'gemini-3-pro-image',
        userId: BILLING_USER,
        request: request({ image_size: '4K', input_images: undefined }),
      }),
    )
    expect(website.image_size).toBe('2K')

    const cli = await createQueueTask({
      entry: 'cli-strict',
      provider: 'gemini',
      model: 'gemini-3-pro-image',
      userId: BILLING_USER,
      strictImageRequest: true,
      request: request({ image_size: '4K', input_images: undefined }),
    })
    expect(cli.kind).toBe('private_billing_denied')
  })
  it('canonicalizes a Gemini extra image size before membership alignment', async () => {
    await ensureBillingUser()
    withMember(false)
    const payload = await storedRequest(
      await createQueueTask({
        entry: 'web-direct',
        provider: 'gemini',
        model: 'gemini-3-pro-image',
        userId: BILLING_USER,
        request: request({
          image_size: '1K',
          input_images: undefined,
          extra: {
            generationConfig: {
              imageConfig: { imageSize: '4K', aspectRatio: '16:9' },
            },
          },
        }),
      }),
    )
    expect(payload.image_size).toBe('2K')
    expect(payload.extra).toMatchObject({
      generationConfig: { imageConfig: { imageSize: '2K', aspectRatio: '16:9' } },
    })
  })
  it('writes the flat Gemini image size into an extra imageConfig that omits it', async () => {
    await ensureBillingUser()
    withMember(false)
    const payload = await storedRequest(
      await createQueueTask({
        entry: 'web-direct',
        provider: 'gemini',
        model: 'gemini-3-pro-image',
        userId: BILLING_USER,
        request: request({
          image_size: '2K',
          input_images: undefined,
          extra: { generationConfig: { imageConfig: { aspectRatio: '16:9' } } },
        }),
      }),
    )
    expect(payload.image_size).toBe('2K')
    expect(payload.extra).toMatchObject({
      generationConfig: { imageConfig: { imageSize: '2K', aspectRatio: '16:9' } },
    })
  })
  it('checks membership before normalizing a Gemini 4K request', async () => {
    await ensureBillingUser()
    let lookedUp = false
    withMember(true, () => {
      lookedUp = true
    })
    const payload = await storedRequest(
      await createQueueTask({
        entry: 'web-direct',
        provider: 'gemini',
        model: 'gemini-3-pro-image',
        userId: BILLING_USER,
        request: request({
          image_size: '1K',
          input_images: undefined,
          extra: { generationConfig: { imageConfig: { imageSize: '4K' } } },
        }),
      }),
    )
    expect(lookedUp).toBe(true)
    expect(payload.image_size).toBe('4K')
    expect(payload.extra).toMatchObject({ generationConfig: { imageConfig: { imageSize: '4K' } } })
  })

  it('keeps a member Gemini 4K submission and matches the prepared hash', async () => {
    await ensureBillingUser()
    withMember(true)
    const input = {
      entry: 'web-direct' as const,
      provider: 'gemini' as const,
      model: 'gemini-3-pro-image',
      userId: BILLING_USER,
      request: request({ image_size: '4K', input_images: undefined }),
    }
    const payload = await storedRequest(await createQueueTask(input))
    expect(payload.image_size).toBe('4K')

    await db.delete(schema.tasks)
    withMember(false)
    const downgraded = await storedRequest(await submitPreparedOnce(input))
    expect(downgraded.image_size).toBe('2K')
  })

  it('keeps the tier decided at preparation when the account becomes a member before submit', async () => {
    await ensureBillingUser()
    withMember(false)
    const outcome = await submitPreparedOnce(
      {
        entry: 'batch',
        provider: 'gemini',
        model: 'gemini-nano-banana-2.1',
        userId: BILLING_USER,
        request: request({ image_size: '4K' }),
      },
      () => withMember(true),
    )
    const payload = await storedRequest(outcome)
    expect(payload.image_size).toBe('2K')
    const [task] = await db.select().from(schema.tasks)
    expect(task!.metering).toMatchObject({ unitMultiplier: 1.5, tier: { memberApplied: false } })
  })

  it('refuses a prepared 4K submission whose membership lapsed and discards its inputs', async () => {
    await ensureBillingUser()
    withMember(true)
    const outcome = await submitPreparedOnce(
      {
        entry: 'batch',
        provider: 'gemini',
        model: 'gemini-nano-banana-2.1',
        userId: BILLING_USER,
        request: request({ image_size: '4K' }),
      },
      () => withMember(false),
    )
    expect(outcome.kind).toBe('private_billing_denied')
    expect(await db.select().from(schema.tasks)).toHaveLength(0)
    expect(store.objects.size).toBe(0)
  })

  it.each([
    { member: false, tier: '2K', multiplier: 1.5 },
    { member: true, tier: '4K', multiplier: 3.4 },
  ])('quotes the Gemini tier actually submitted for member=$member', async ({
    member,
    tier,
    multiplier,
  }) => {
    await ensureBillingUser()
    withMember(member)
    const estimate = await db.transaction((tx) =>
      quoteBatchPlan(tx, BILLING_USER, [
        {
          key: 'image',
          ordinal: 0,
          kind: 'generation',
          prompt: 'a cup',
          inputs: [],
          dependencies: [],
          params: { model: 'gemini-nano-banana-2.1', provider: 'gemini', gemini_image_size: '4K' },
        },
      ]),
    )
    expect(estimate.generation.status).toBe('available')
    if (estimate.generation.status !== 'available') throw new Error('expected a quote')
    expect(estimate.generation.snapshots[0]!.unitMultiplier).toBe(multiplier)
    const input = {
      entry: 'batch' as const,
      provider: 'gemini' as const,
      model: 'gemini-nano-banana-2.1',
      userId: BILLING_USER,
      request: { prompt: 'a cup', image_size: '4K' as const },
    }
    const payload = await storedRequest(await submitPreparedOnce(input))
    expect(payload.image_size).toBe(tier)
  })
})
describe('submitPrepared', () => {
  const input = (prompt = 'a cup') => ({
    entry: 'look' as const,
    provider: 'openai-compat' as const,
    model: 'gpt-image-2.5-flare',
    userId: null,
    request: request({ prompt }),
  })

  it('keeps the inputs of created tasks', async () => {
    const result = await submitPrepared([input()], (_tx, submit) => submit(0))
    expect(result.kind).toBe('committed')
    if (result.kind !== 'committed' || result.value.kind !== 'created')
      throw new Error('expected a task')
    const kept = result.value.taskId
    const keys = [...store.objects.keys()]
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.every((key) => key.startsWith(`${kept}/in/`))).toBe(true)
  })

  it('discards every archived input when the transaction rolls back', async () => {
    await expect(
      submitPrepared([input('one'), input('two')], async (_tx, submit) => {
        expect((await submit(0)).kind).toBe('created')
        expect((await submit(1)).kind).toBe('created')
        throw new Error('caller rolled back')
      }),
    ).rejects.toThrow('caller rolled back')
    expect(await db.select().from(schema.tasks)).toHaveLength(0)
    expect(store.objects.size).toBe(0)
  })

  it('discards the inputs the transaction did not turn into a task', async () => {
    const result = await submitPrepared([input('one'), input('two')], (_tx, submit) => submit(1))
    if (result.kind !== 'committed' || result.value.kind !== 'created')
      throw new Error('expected a task')
    const kept = result.value.taskId
    expect(store.objects.size).toBeGreaterThan(0)
    expect([...store.objects.keys()].every((key) => key.startsWith(`${kept}/in/`))).toBe(true)
  })

  it('rolls back and discards inputs when work swallows a submit error', async () => {
    _setPrivateBffOverlayForTesting({
      ...EMPTY_PRIVATE_BFF_OVERLAY,
      present: true,
      taskHooks: {
        ...EMPTY_PRIVATE_BFF_OVERLAY.taskHooks,
        meteringDecision: async () => {
          throw new Error('metering hook failed')
        },
      },
    })
    await expect(
      submitPrepared([{ ...input(), userId: BILLING_USER }], async (_tx, submit) => {
        await submit(0).catch(() => undefined)
      }),
    ).rejects.toThrow('metering hook failed')
    expect(await db.select().from(schema.tasks)).toHaveLength(0)
    expect(store.objects.size).toBe(0)
  })

  it('refuses before the transaction and discards earlier preparations', async () => {
    let ran = false
    const result = await submitPrepared(
      [
        input('one'),
        { ...input('two'), request: request({ input_images: ['data:image/png;base64,'] }) },
      ],
      async () => {
        ran = true
      },
    )
    expect(result).toMatchObject({ kind: 'refused', index: 1 })
    expect(ran).toBe(false)
    expect(store.objects.size).toBe(0)
  })
})

it('ignores a strict flag supplied inside a website request body', async () => {
  const outcome = await createQueueTask({
    entry: 'web-direct',
    provider: 'openai-compat',
    model: 'gpt-image-2.5-flare',
    userId: null,
    request: { ...request({ input_images: undefined }), ...{ strict_image_request: true } },
  })
  expect(outcome.kind).toBe('created')
  if (outcome.kind !== 'created') throw new Error('expected a website task')
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, outcome.taskId))
  expect(task!.request_payload).not.toHaveProperty('strict_image_request')
})

it('replays an existing command when strict execution policy is introduced', async () => {
  await ensureBillingUser()
  const input = {
    entry: 'web-direct' as const,
    provider: 'openai-compat' as const,
    model: 'gpt-image-2.5-flare',
    userId: BILLING_USER,
    request: request({ input_images: undefined, client_request_id: crypto.randomUUID() }),
  }
  const original = await createQueueTask(input)
  expect(original.kind).toBe('created')
  const replay = await createQueueTask({ ...input, entry: 'cli-strict', strictImageRequest: true })
  expect(replay).toEqual(original)
  const rollbackReplay = await createQueueTask(input)
  expect(rollbackReplay).toEqual(original)
  expect(await db.select().from(schema.tasks)).toHaveLength(1)
})

afterAll(close)

const AGENT = { conversationId: 'conversation-1', turnId: 'turn-1' } as const
const VIDEO = { duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p' } as const

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

interface Submission {
  readonly agent: boolean
  readonly mask: boolean
  readonly video: boolean
}

async function submit(input: Submission) {
  const outcome = await createQueueTask({
    entry: 'agent',
    provider: 'openai-compat',
    // 自定义尺寸的那一支，原尺寸局部编辑才走得通。
    model: input.video ? 'veo-3.1-fast-generate-preview' : 'gpt-image-2.5-flare',
    request: request(input.mask ? { mask: MASK } : {}),
    ...(input.video ? { video: VIDEO } : {}),
    userId: null,
    ...(input.agent ? { agent: AGENT } : {}),
  })
  expect(outcome.kind).toBe('created')
  if (outcome.kind !== 'created') throw new Error('unreachable')
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, outcome.taskId))
  return task!.request_payload
}

const describeSubmission = (input: Submission) =>
  `${input.agent ? 'an agent' : 'a workbench'} ${input.video ? 'video' : 'image'} submission ${input.mask ? 'with' : 'without'} a selection`

/**
 * 一句话不变式：`preserve_outside_mask` 与 `masked_original_size` 是同一个判定的一对事实
 * ——要么都落库、要么都不落库，且只要是「选区 + 非视频」就落，与提交方是智能体还是画布 /
 * 工作台无关。
 * worker 靠前者决定保护选区外像素，靠后者把补边裁回原尺寸；只出现一个就是坏任务。
 */
for (const agent of [false, true])
  for (const mask of [false, true])
    for (const video of [false, true]) {
      const submission = { agent, mask, video }
      const masked = mask && !video
      it(`${masked ? 'records' : 'omits'} both masked facts for ${describeSubmission(submission)}`, async () => {
        const payload = await submit(submission)

        const present = (['preserve_outside_mask', 'masked_original_size'] as const).filter((key) =>
          Object.hasOwn(payload, key),
        )
        expect(present).toEqual(masked ? ['preserve_outside_mask', 'masked_original_size'] : [])
        if (masked) {
          expect(payload.preserve_outside_mask).toBe(true)
          expect(payload.masked_original_size).toEqual({ width: WIDTH, height: HEIGHT })
        }
      })
    }

it('pads a masked image submission to the model grid and keeps it lossless', async () => {
  const payload = await submit({ agent: true, mask: true, video: false })

  // 补边后的像素才是送上游的那一份；交付时按原尺寸裁回去。
  expect(payload.size).toBe('1008x784')
  expect(await sharp(await store.read(payload.input_images![0]!.object)).metadata()).toMatchObject({
    width: 1008,
    height: 784,
  })
  // 保护选区外像素要逐像素比对，有损格式与压缩会把它毁掉。
  expect(payload.output_format).toBe('png')
  expect(payload).not.toHaveProperty('output_compression')
  // 带透明度的结果合成不回原图，局部编辑一律要不透明背景。
  expect(payload.extra?.background).toBe('opaque')
})

it('pads a masked image submission that no agent sent on the same terms', async () => {
  const payload = await submit({ agent: false, mask: true, video: false })

  expect(payload.size).toBe('1008x784')
  expect(await sharp(await store.read(payload.input_images![0]!.object)).metadata()).toMatchObject({
    width: 1008,
    height: 784,
  })
  expect(payload.masked_original_size).toEqual({ width: WIDTH, height: HEIGHT })
})

// 不是遮罩提交就不该被改写：格式、压缩、选区、视频参数都按调用方给的原样落库。
for (const submission of [
  { agent: true, mask: false, video: false },
  { agent: false, mask: false, video: false },
  { agent: true, mask: true, video: true },
])
  it(`keeps ${describeSubmission(submission)} in the format its caller asked for`, async () => {
    const payload = await submit(submission)

    expect(payload.output_format).toBe('jpeg')
    expect(payload.output_compression).toBe(80)
    if (submission.mask) expect(payload.mask).toBeDefined()
    if (submission.video)
      expect(payload.video).toMatchObject({ duration_seconds: 5, resolution: '720p' })
  })
