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
      async reserveTask({ tx: _tx, ...rest }: Parameters<PrivateTaskHooks['reserveTask']>[0]) {
        reservations.push(rest)
        return { kind: 'reserved' as const }
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
]

beforeEach(async () => {
  reservations.length = 0
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

async function submit(model: string, body: Record<string, unknown>): Promise<number> {
  const response = await app.handle(
    new Request(`http://localhost/v1/queue/openai-compat/${model}/submit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
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
  return response.status
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
