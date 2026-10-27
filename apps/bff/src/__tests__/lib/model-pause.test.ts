import { afterAll, afterEach, beforeEach, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { ManagedModelsView } from '@image-playground/shared'

const TEST_DB = await resetTestDatabase('bff_model_pause')

process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.DATABASE_URL = TEST_DB
process.env.INTERNAL_API_TOKEN = 'fixture-service-credential-alpha'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../quota-operator-config.json')

const { app } = await import('../../app')
const { close: closeDb, db, schema } = await import('../../db/client')
const { finishTask, heldBy } = await import('../../db/task-transitions')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { _resetInactiveModelsForTesting, modelUnavailable, refreshInactiveModels } = await import(
  '../../lib/model-availability'
)
type InternalChannel = import('../../lib/channels').InternalChannel
type TaskErrorType = import('@image-playground/shared').TaskErrorType

const TOKEN = 'model-pause-worker'
const MODEL = 'grok-imagine-video-1.5-lite'

const channel: InternalChannel = {
  id: 'grok-video',
  kind: 'openai-queue',
  label: 'Grok',
  baseUrl: 'https://gateway.example/v1',
  auth: { type: 'bearer', secretRef: 'VIDEO_API_KEY', secret: 'k' },
  allowedPaths: ['videos/generations'],
  models: [
    { id: MODEL, label: 'Grok Video Lite', media: 'video', capabilities: ['generate'] },
    { id: 'grok-imagine-video', label: 'Grok Video', media: 'video', capabilities: ['generate'] },
  ],
  defaults: { asyncTasks: true },
}

async function fail(id: string, errorType: TaskErrorType) {
  await db.insert(schema.tasks).values({
    id,
    provider: 'openai-compat',
    model: MODEL,
    status: 'in_progress',
    execution_token: TOKEN,
    lease_expires_at: Date.now() + 60_000,
    request_payload: { prompt: 'pause fixture', device_id: 'pause-device' },
    submitted_at: Date.now(),
  })
  await finishTask(
    id,
    { status: 'failed', errorMessage: 'no account', errorType, completedAt: Date.now() },
    heldBy(TOKEN),
  )
}

function internal(path: string, init: RequestInit = {}) {
  return app.handle(
    new Request(`http://localhost/internal/admin/models${path}`, {
      ...init,
      headers: {
        authorization: 'Bearer fixture-service-credential-alpha',
        'content-type': 'application/json',
        'x-admin-operator': 'op-1',
      },
    }),
  )
}

async function listed(): Promise<ManagedModelsView['models']> {
  const response = await internal('/')
  expect(response.status).toBe(200)
  return ((await response.json()) as ManagedModelsView).models
}

const paused = () => db.transaction((tx) => modelUnavailable(tx, MODEL))

beforeEach(async () => {
  _setChannelsForTesting([channel])
  await db.delete(schema.tasks)
  await db.delete(schema.model_availability)
  await db.delete(schema.operator_audits)
})

afterEach(() => {
  _setChannelsForTesting([])
  _resetInactiveModelsForTesting()
})

afterAll(async () => {
  await closeDb()
})

it('pauses a model once the upstream has no eligible account, and resuming clears it', async () => {
  await fail('pause-1', 'model_unavailable')
  await fail('pause-2', 'model_unavailable')

  expect(await paused()).toBe(true)
  expect(await refreshInactiveModels()).toEqual(new Set([MODEL]))
  const [entry] = (await listed()).filter((model) => model.id === MODEL)
  expect(entry).toMatchObject({
    kind: 'video',
    active: false,
    pause_reason: 'upstream_unavailable',
  })
  expect(entry?.paused_at).toBeNumber()
  // 第二次失败时它已经停了，不再记一次自动暂停。
  const audits = await db.select().from(schema.operator_audits)
  expect(audits.map((audit) => audit.action)).toEqual(['model.auto_pause'])

  const resumed = await internal(`/${MODEL}`, {
    method: 'PUT',
    body: JSON.stringify({ active: true }),
  })
  expect(resumed.status).toBe(200)
  expect(await paused()).toBe(false)
  expect((await listed()).find((model) => model.id === MODEL)).toMatchObject({
    active: true,
    pause_reason: null,
    paused_at: null,
  })
  expect(await refreshInactiveModels()).toEqual(new Set())
})

it('leaves other failures and manual stops alone', async () => {
  await fail('other-failure', 'upstream_error')
  expect(await paused()).toBe(false)

  await internal(`/${MODEL}`, { method: 'PUT', body: JSON.stringify({ active: false }) })
  await fail('after-manual-stop', 'model_unavailable')
  // 运营手动下架的不改写成自动暂停。
  expect((await listed()).find((model) => model.id === MODEL)).toMatchObject({
    active: false,
    pause_reason: null,
  })
})

it('hides stopped models from the page', async () => {
  await internal(`/${MODEL}`, { method: 'PUT', body: JSON.stringify({ active: false }) })
  const response = await app.handle(new Request('http://localhost/api/channels'))
  const body = (await response.json()) as { channels: Array<{ models: Array<{ id: string }> }> }
  const ids = body.channels.flatMap((entry) => entry.models.map((model) => model.id))
  expect(ids).toContain('grok-imagine-video')
  expect(ids).not.toContain(MODEL)
})
