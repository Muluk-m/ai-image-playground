import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  _setPrivateBffOverlayForTesting,
  EMPTY_PRIVATE_BFF_OVERLAY,
  type PrivateTaskHooks,
} from '../../lib/private-overlay'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

const TEST_DB = await resetTestDatabase('bff_billing_reserve')

const quotaState = { used: 0, quota: 1, mode: 'credits' as 'credits' | 'none' }
type Reservation = Omit<Parameters<PrivateTaskHooks['reserveTask']>[0], 'tx'>
const reservations: Reservation[] = []

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.CORS_ALLOWED_ORIGINS = '*'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../billing-reserve-operator-config.json',
)

// billing:credits 要求 overlay 在场，桩必须在 app 求值前装好。
_setPrivateBffOverlayForTesting(
  Object.freeze({
    ...EMPTY_PRIVATE_BFF_OVERLAY,
    present: true,
    taskHooks: {
      ...EMPTY_PRIVATE_BFF_OVERLAY.taskHooks,
      async meteringDecision() {
        return quotaState.mode === 'none'
          ? ({ kind: 'unmetered', metering: 'none' } as const)
          : ({ kind: 'metered', metering: 'credits' } as const)
      },
      async consumeUnmeteredQuota() {
        if (quotaState.used >= quotaState.quota)
          return {
            kind: 'quota_exceeded' as const,
            quota: quotaState.quota,
            used: quotaState.used,
            resetAt: '2099-01-01T00:00:00.000Z',
          }
        quotaState.used += 1
        return { kind: 'consumed' as const }
      },
      async reserveTask({ tx: _tx, ...rest }: Parameters<PrivateTaskHooks['reserveTask']>[0]) {
        reservations.push(rest)
        return { kind: 'reserved' as const, credits: 0 }
      },
    },
  }),
)

const { app } = await import('../../app')
const { close: closeDb, db, schema } = await import('../../db/client')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { hashSessionToken, USER_SESSION_COOKIE } = await import('../../lib/user-session')
type InternalChannel = import('../../lib/channels').InternalChannel

const SESSION_TOKEN = 'billing-reserve-session-token'
const channels: InternalChannel[] = [
  {
    id: 'openai-images',
    kind: 'openai-queue',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    auth: { type: 'bearer', secretRef: 'OPENAI_API_KEY', secret: 'k' },
    allowedPaths: ['images/generations'],
    models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate'] }],
    defaults: {},
  },
  {
    id: 'grok-video',
    kind: 'openai-queue',
    label: 'Grok Video',
    baseUrl: 'https://gateway.example/v1',
    auth: { type: 'bearer', secretRef: 'GROK_API_KEY', secret: 'k' },
    allowedPaths: ['videos'],
    models: [
      {
        id: 'grok-imagine-video',
        label: 'Grok Imagine',
        media: 'video',
        capabilities: ['generate', 'duration', 'aspect_ratio', 'resolution', 'first_frame'],
      },
    ],
    defaults: { asyncTasks: true },
  },
  {
    id: 'veo-video',
    kind: 'openai-queue',
    label: 'Veo',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    auth: { type: 'bearer', secretRef: 'VEO_API_KEY', secret: 'k' },
    allowedPaths: ['models'],
    models: [
      {
        id: 'veo-3.1-fast-generate-preview',
        label: 'Veo 3.1 Fast',
        media: 'video',
        capabilities: ['generate', 'duration', 'aspect_ratio', 'resolution', 'first_frame'],
      },
    ],
    defaults: { asyncTasks: true },
  },
]

beforeEach(async () => {
  reservations.length = 0
  quotaState.used = 0
  quotaState.mode = 'credits'
  setObjectStoreForTesting(new InMemoryObjectStore())
  _setChannelsForTesting(channels)
  await db.delete(schema.tasks)
  await db.delete(schema.user_sessions)
  await db.delete(schema.users)
  const now = Date.now()
  await db.insert(schema.users).values({
    id: 'billing-user',
    username: 'billing.user',
    password_hash: 'hash',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  await db.insert(schema.user_sessions).values({
    token_hash: hashSessionToken(SESSION_TOKEN),
    user_id: 'billing-user',
    created_at: now,
    expires_at: now + 60_000,
  })
})

afterAll(async () => {
  _setPrivateBffOverlayForTesting()
  setObjectStoreForTesting()
  _setChannelsForTesting([])
  await closeDb()
})

async function submitResponse(
  model: string,
  body: Record<string, unknown>,
  origin = 'https://app.example.test',
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/v1/queue/openai-compat/${model}/submit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        cookie: `${USER_SESSION_COOKIE}=${SESSION_TOKEN}`,
      },
      body: JSON.stringify({
        prompt: 'a cat surfing',
        device_id: 'test-device-aaaa-bbbb-cccc',
        client_request_id: crypto.randomUUID(),
        ...body,
      }),
    }),
  )
}

async function submit(model: string, body: Record<string, unknown>): Promise<number> {
  return (await submitResponse(model, body)).status
}

describe('billing reservation units', () => {
  it('reserves an image task by image count at multiplier one', async () => {
    expect(await submit('gpt-image-2', { n: 3 })).toBe(200)

    expect(reservations).toEqual([
      {
        taskId: expect.any(String),
        userId: 'billing-user',
        model: 'gpt-image-2',
        quantity: 3,
        unitMultiplier: 1,
      },
    ])
  })

  it('rejects a video duration that is not one of the model tiers', async () => {
    _setChannelsForTesting([
      {
        ...channels[1]!,
        models: [{ ...channels[1]!.models[0]!, id: 'grok-imagine-video-1.5-lite' }],
      },
    ])
    expect(
      await submit('grok-imagine-video-1.5-lite', {
        video: { duration_seconds: 1.9, aspect_ratio: '16:9', resolution: '720p' },
      }),
    ).toBe(400)
    expect(reservations).toEqual([])
    expect(await db.select().from(schema.tasks)).toHaveLength(0)
    expect(
      await submit('grok-imagine-video-1.5-lite', {
        video: { duration_seconds: 2, aspect_ratio: '16:9', resolution: '720p' },
      }),
    ).toBe(200)
    expect(reservations).toEqual([
      {
        taskId: expect.any(String),
        userId: 'billing-user',
        model: 'grok-imagine-video-1.5-lite',
        quantity: 2,
        unitMultiplier: 1,
      },
    ])
    const [task] = await db.select().from(schema.tasks)
    expect(task?.request_payload).toMatchObject({
      video: { duration_seconds: 2, resolution: '720p' },
    })
  })

  it('reserves a video task by seconds at the multiplier that model prices the resolution at', async () => {
    const status = await submit('grok-imagine-video', {
      video: { duration_seconds: 8, aspect_ratio: '16:9', resolution: '1080p' },
    })

    expect(status).toBe(200)
    expect(reservations).toEqual([
      {
        taskId: expect.any(String),
        userId: 'billing-user',
        model: 'grok-imagine-video',
        quantity: 8,
        unitMultiplier: 1.6,
      },
    ])
  })

  it('reserves Veo 1080p a fifth above its 720p seconds', async () => {
    expect(
      await submit('veo-3.1-fast-generate-preview', {
        video: { duration_seconds: 8, aspect_ratio: '16:9', resolution: '1080p' },
      }),
    ).toBe(200)
    expect(reservations).toEqual([
      {
        taskId: expect.any(String),
        userId: 'billing-user',
        model: 'veo-3.1-fast-generate-preview',
        quantity: 8,
        unitMultiplier: 1.2,
      },
    ])

    reservations.length = 0
    expect(
      await submit('veo-3.1-fast-generate-preview', {
        video: { duration_seconds: 4, aspect_ratio: '9:16', resolution: '720p' },
      }),
    ).toBe(200)
    expect(reservations).toEqual([
      {
        taskId: expect.any(String),
        userId: 'billing-user',
        model: 'veo-3.1-fast-generate-preview',
        quantity: 4,
        unitMultiplier: 1,
      },
    ])
  })

  it('reserves a 720p video task at multiplier one', async () => {
    const status = await submit('grok-imagine-video', {
      video: { duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p' },
    })

    expect(status).toBe(200)
    expect(reservations).toEqual([
      {
        taskId: expect.any(String),
        userId: 'billing-user',
        model: 'grok-imagine-video',
        quantity: 5,
        unitMultiplier: 1,
      },
    ])
  })
})

describe('repeated submissions', () => {
  it('creates and charges one task when the same request arrives twice under different command ids', async () => {
    const statuses = await Promise.all([
      submit('gpt-image-2', { prompt: 'a double click' }),
      submit('gpt-image-2', { prompt: 'a double click' }),
    ])

    expect(statuses.sort()).toEqual([200, 409])
    expect(reservations).toHaveLength(1)
    expect(await db.select().from(schema.tasks)).toHaveLength(1)
  })

  it('catches a double click that carries no command id', async () => {
    expect(await submit('gpt-image-2', { prompt: 'no id', client_request_id: undefined })).toBe(200)
    expect(await submit('gpt-image-2', { prompt: 'no id', client_request_id: undefined })).toBe(409)
    expect(reservations).toHaveLength(1)
  })

  it('still lets a different request through right away', async () => {
    expect(await submit('gpt-image-2', { prompt: 'first' })).toBe(200)
    expect(await submit('gpt-image-2', { prompt: 'second' })).toBe(200)
    expect(reservations).toHaveLength(2)
  })

  it('lets the same request through again once the earlier task failed', async () => {
    expect(await submit('gpt-image-2', { prompt: 'retry me' })).toBe(200)
    await db.update(schema.tasks).set({ status: 'failed' })
    expect(await submit('gpt-image-2', { prompt: 'retry me' })).toBe(200)
    expect(reservations).toHaveLength(2)
  })

  it('leaves canvas candidates alone: one canvas run may hold identical nodes', async () => {
    const body = { prompt: 'same node twice', output_retention: 'candidate' }
    expect(await submit('gpt-image-2', body)).toBe(200)
    expect(await submit('gpt-image-2', body)).toBe(200)
    expect(reservations).toHaveLength(2)
  })

  it('leaves other entry points alone: a batch may hold identical items', async () => {
    const { createQueueTask } = await import('../../lib/taskSubmission')
    const input = {
      provider: 'openai-compat' as const,
      model: 'gpt-image-2',
      request: { prompt: 'same look twice' },
      userId: 'billing-user',
    }

    expect((await createQueueTask(input)).kind).toBe('created')
    expect((await createQueueTask(input)).kind).toBe('created')
    expect(reservations).toHaveLength(2)
  })

  it('refuses a blank prompt on every entry point before reserving', async () => {
    const { createQueueTask } = await import('../../lib/taskSubmission')
    const outcome = await createQueueTask({
      provider: 'openai-compat',
      model: 'gpt-image-2',
      request: { prompt: '\u200b \u0007' },
      userId: 'billing-user',
    })

    expect(outcome.kind).toBe('invalid_prompt')
    expect(reservations).toHaveLength(0)
    expect(await db.select().from(schema.tasks)).toHaveLength(0)
  })

  it('replays the same command id instead of rejecting it', async () => {
    const client_request_id = crypto.randomUUID()
    expect(await submit('gpt-image-2', { prompt: 'network retry', client_request_id })).toBe(200)
    expect(await submit('gpt-image-2', { prompt: 'network retry', client_request_id })).toBe(200)
    expect(reservations).toHaveLength(1)
  })
})

describe('HTTP metering decisions and quota consumption', () => {
  it('runs an unmetered image request across an allowed Origin and persists the task snapshot', async () => {
    quotaState.mode = 'none'
    const response = await submitResponse('gpt-image-2', {
      client_request_id: 'unmetered-image-cross-origin',
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example.test')
    const [task] = await db.select().from(schema.tasks)
    expect(task).toMatchObject({ user_id: 'billing-user', client_request_id: 'unmetered-image-cross-origin' })
    expect(task?.metering).toMatchObject({ mode: 'none' })
    expect(reservations).toHaveLength(0)
    expect(quotaState.used).toBe(1)
  })

  it('applies the same unmetered quota path to video from another Origin', async () => {
    quotaState.mode = 'none'
    const response = await submitResponse(
      'grok-imagine-video',
      { video: { duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p' } },
      'https://studio.example.test',
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://studio.example.test')
    const [task] = await db.select().from(schema.tasks)
    expect(task?.metering).toMatchObject({ mode: 'none' })
    expect(quotaState.used).toBe(1)
  })

  it('returns quota_exceeded over HTTP without leaving a task behind', async () => {
    quotaState.mode = 'none'
    quotaState.used = quotaState.quota
    const response = await submitResponse('gpt-image-2', { client_request_id: 'quota-refused' })
    expect(response.status).toBe(429)
    expect(await response.json()).toMatchObject({ error: 'daily_quota_exceeded', quota: 1, used: 1 })
    expect(await db.select().from(schema.tasks)).toHaveLength(0)
  })

  it('does not consume quota twice when the same client request is replayed', async () => {
    quotaState.mode = 'none'
    const body = { client_request_id: 'same-unmetered-request' }
    expect((await submitResponse('gpt-image-2', body)).status).toBe(200)
    expect((await submitResponse('gpt-image-2', body)).status).toBe(200)
    expect(quotaState.used).toBe(1)
    expect(await db.select().from(schema.tasks)).toHaveLength(1)
  })
  it('rejects a concurrent quota loser without leaving its task behind', async () => {
    quotaState.mode = 'none'
    const responses = await Promise.all([
      submitResponse('gpt-image-2', { client_request_id: 'concurrent-quota-a' }),
      submitResponse('gpt-image-2', { client_request_id: 'concurrent-quota-b' }),
    ])
    expect(responses.map((one) => one.status).sort()).toEqual([200, 429])
    expect(await db.select().from(schema.tasks)).toHaveLength(1)
    expect(quotaState.used).toBe(1)
  })
})
