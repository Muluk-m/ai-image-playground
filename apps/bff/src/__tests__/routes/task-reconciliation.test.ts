import { afterAll, beforeEach, expect, it, spyOn } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { QUEUE_TIMEOUTS } from '@image-playground/shared'
import { sql } from 'drizzle-orm'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'

process.env.DATABASE_URL = await resetTestDatabase('bff_task_reconciliation')
process.env.PORT = '0'
process.env.DATABASE_POOL_MAX = '1'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'test'
process.env.UPSTREAM_ASYNC_IMAGE_TASKS = 'true'
process.env.INTERNAL_API_TOKEN = 'reconcile-service-token'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../task-reconciliation-operator-config.json',
)
const billing = installRecordingTaskHooks()
const { app } = await import('../../app')
const { db, schema, close } = await import('../../db/client')
const { runTask } = await import('../../workers/task-runner')
const { recoverTasksByIds, purgeOldTasks } = await import('../../db/maintenance')
const { setUpstreamFetchForTesting, setAsyncPollBackoffForTesting } = await import(
  '../../lib/upstream'
)
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { setDurableMediaStoreForTesting } = await import('../../lib/durableMediaStore')
class DurableFixture extends InMemoryObjectStore {
  sign(key: string) {
    return `https://durable.example/${key}`
  }
}
const sharp = (await import('sharp')).default
const PNG_BASE64 = (
  await sharp({ create: { width: 2, height: 2, channels: 3, background: '#abcdef' } })
    .png()
    .toBuffer()
).toString('base64')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { hashSessionToken, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const token = 'task-reconciliation-session'
let dispatches = 0
const request = (path: string, method = 'GET', body?: unknown) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: `${USER_SESSION_COOKIE}=${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  )
beforeEach(async () => {
  billing.reset()
  dispatches = 0
  setObjectStoreForTesting(new InMemoryObjectStore())
  setDurableMediaStoreForTesting(new DurableFixture())
  setUpstreamFetchForTesting(async () => {
    dispatches++
    throw new Error('connection lost after upstream acceptance')
  })
  _setChannelsForTesting([
    {
      id: 'openai-images',
      kind: 'openai-queue',
      label: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      auth: { type: 'bearer', secretRef: 'OPENAI_API_KEY', secret: 'test' },
      allowedPaths: ['images/generations'],
      models: [{ id: 'gpt-image-2', label: 'GPT Image 2', capabilities: ['generate'] }],
      defaults: {},
    },
  ])
  await db.delete(schema.tasks)
  await db.delete(schema.agent_conversations)
  await db.delete(schema.user_sessions)
  await db.delete(schema.users)
  await db.insert(schema.users).values({
    id: 'reconcile-user',
    username: 'reconcile-user',
    password_hash: 'hash',
    status: 'active',
    created_at: Date.now(),
    updated_at: Date.now(),
  })
  await db.insert(schema.user_sessions).values({
    token_hash: hashSessionToken(token),
    user_id: 'reconcile-user',
    created_at: Date.now(),
    expires_at: Date.now() + 60_000,
  })
})
afterAll(async () => {
  setUpstreamFetchForTesting()
  setObjectStoreForTesting()
  setDurableMediaStoreForTesting()
  _setChannelsForTesting([])
  await close()
})
it('holds an explicitly opted-in unknown task through cancellation, recovery and retention without a second dispatch', async () => {
  const submitted = await request('/v1/queue/openai-compat/gpt-image-2/submit', 'POST', {
    prompt: 'a cat',
    device_id: 'test-device-reconcile',
    client_request_id: crypto.randomUUID(),
  })
  expect(submitted.status).toBe(200)
  const { request_id: id } = (await submitted.json()) as { request_id: string }
  // Represents a future server-only producer opt-in. Existing HTTP clients cannot enable this.
  await db.execute(sql`update tasks set reconciliation_required = true where id = ${id}`)
  await runTask(id)
  expect(await (await request(`/v1/queue/requests/${id}/status`)).json()).toMatchObject({
    status: 'reconciling',
    phase: 'reconciling',
  })
  expect(billing.reservations).toHaveLength(1)
  expect(billing.settlements).toHaveLength(0)
  expect(await (await request(`/v1/queue/requests/${id}/cancel`, 'PUT')).json()).toMatchObject({
    status: 'reconciling',
  })
  await recoverTasksByIds([id])
  await purgeOldTasks(0)
  await runTask(id)
  expect(dispatches).toBe(1)
  expect(billing.settlements).toHaveLength(0)
  expect(await (await request(`/v1/queue/requests/${id}/status`)).json()).toMatchObject({
    status: 'reconciling',
  })
})

const operate = (id: string, method = 'GET', body?: unknown) =>
  app.handle(
    new Request(`http://localhost/internal/admin/tasks/${id}/reconciliation`, {
      method,
      headers: {
        authorization: 'Bearer reconcile-service-token',
        'content-type': 'application/json',
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  )
it('records dispatch evidence and settles a manually confirmed absence once, rejecting command reuse and unauthenticated operators', async () => {
  const submitted = await request('/v1/queue/openai-compat/gpt-image-2/submit', 'POST', {
    prompt: 'another cat',
    device_id: 'test-device-reconcile',
    client_request_id: crypto.randomUUID(),
  })
  const { request_id: id } = (await submitted.json()) as { request_id: string }
  await db.execute(sql`update tasks set reconciliation_required = true where id = ${id}`)
  await runTask(id)
  const unauthenticated = await request(`/internal/admin/tasks/${id}/reconciliation`, 'POST', {
    action: 'confirm_no_result',
    commandId: 'unauthorized',
    operatorId: 'operator',
    evidence: 'provider confirmed absence',
  })
  expect(unauthenticated.status).toBe(401)
  const read = await operate(id)
  expect(read.status).toBe(200)
  expect(await read.json()).toMatchObject({
    status: 'reconciling',
    dispatches: [{ intendedAt: expect.any(Number), dispatchedAt: expect.any(Number) }],
  })
  const command = {
    action: 'confirm_no_result',
    commandId: 'confirmed-absence',
    operatorId: 'operator@example.com',
    evidence: 'Provider support case 314: no output was generated.',
  }
  const settled = await operate(id, 'POST', command)
  expect(settled.status).toBe(200)
  expect(await settled.json()).toMatchObject({ status: 'failed' })
  expect(await (await operate(id, 'POST', command)).json()).toMatchObject({ status: 'failed' })
  expect((await operate(id, 'POST', { ...command, evidence: 'different evidence' })).status).toBe(
    409,
  )
  expect(billing.settlements).toHaveLength(1)
  expect(billing.settlements[0]).toMatchObject({
    taskId: id,
    outcome: 'failed',
    upstreamInvocationCount: 1,
  })
  expect(dispatches).toBe(1)
  expect(await (await operate(id)).json()).toMatchObject({
    decisions: [
      {
        operatorId: 'operator@example.com',
        evidence: command.evidence,
        commandId: command.commandId,
        status: 'failed',
      },
    ],
  })
})
it('queries the original upstream ID, archives its real result and commits once without another generation', async () => {
  let submits = 0
  let lookups = 0
  let found = false
  const actualNow = Date.now()
  let fixtureNow = actualNow
  const clock = spyOn(Date, 'now').mockImplementation(() => fixtureNow)
  setAsyncPollBackoffForTesting([0])
  setUpstreamFetchForTesting(async (url) => {
    if (String(url).endsWith('/async')) {
      submits++
      return new Response(JSON.stringify({ task_id: 'imgtask_original', status: 'processing' }), {
        status: 202,
        headers: { 'x-request-id': 'provider-request-42' },
      })
    }
    lookups++
    if (!found) {
      fixtureNow = actualNow + QUEUE_TIMEOUTS.UPSTREAM_HARD_TIMEOUT_MS + 1
      return new Response(JSON.stringify({ status: 'processing' }))
    }
    return new Response(
      JSON.stringify({ status: 'completed', result: { data: [{ b64_json: PNG_BASE64 }] } }),
    )
  })
  const submitted = await request('/v1/queue/openai-compat/gpt-image-2/submit', 'POST', {
    prompt: 'recover a cat',
    device_id: 'test-device-reconcile',
    client_request_id: crypto.randomUUID(),
  })
  const { request_id: id } = (await submitted.json()) as { request_id: string }
  await db.execute(sql`update tasks set reconciliation_required = true where id = ${id}`)
  try {
    await runTask(id)
  } finally {
    clock.mockRestore()
    setAsyncPollBackoffForTesting()
  }
  await recoverTasksByIds([id])
  expect(await (await operate(id)).json()).toMatchObject({
    status: 'reconciling',
    upstreamTaskIds: ['imgtask_original'],
    dispatches: [{ upstreamRequestId: 'provider-request-42' }],
  })
  found = true
  const command = {
    action: 'lookup',
    commandId: 'lookup-original',
    operatorId: 'operator@example.com',
    evidence: 'Query original provider task',
  }
  const resolved = await operate(id, 'POST', command)
  expect(resolved.status).toBe(200)
  expect(await resolved.json()).toMatchObject({ status: 'completed' })
  expect(await (await request(`/v1/queue/requests/${id}/status`)).json()).toMatchObject({
    status: 'completed',
    result: { images: [{ index: 0, mime: 'image/png' }] },
  })
  expect((await request(`/v1/queue/requests/${id}/image/0`)).status).toBe(200)
  const lookupCount = lookups
  await operate(id, 'POST', command)
  expect(lookups).toBe(lookupCount)
  expect(submits).toBe(1)
  expect(billing.settlements).toHaveLength(1)
  expect(billing.settlements[0]).toMatchObject({ outcome: 'completed', upstreamInvocationCount: 1 })
})

it('keeps a dispatched job and its inputs auditable after deleting its conversation', async () => {
  const opened = await request('/api/agent/conversations', 'POST', {
    deviceId: 'test-device-reconcile',
  })
  expect(opened.status).toBe(200)
  const { conversation } = (await opened.json()) as { conversation: { id: string } }
  const submitted = await request('/v1/queue/openai-compat/gpt-image-2/submit', 'POST', {
    prompt: 'edit the source',
    device_id: 'test-device-reconcile',
    client_request_id: crypto.randomUUID(),
    input_images: [`data:image/png;base64,${PNG_BASE64}`],
  })
  expect(submitted.status).toBe(200)
  const { request_id: id } = (await submitted.json()) as { request_id: string }
  await db.execute(
    sql`update tasks set reconciliation_required = true, agent_conversation_id = ${conversation.id} where id = ${id}`,
  )
  let signalStarted!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  setUpstreamFetchForTesting(async () => {
    dispatches++
    signalStarted()
    await waiting
    throw new Error('connection lost')
  })
  const running = runTask(id)
  await started
  try {
    const deleted = await request(`/api/agent/conversations/${conversation.id}`, 'DELETE', {
      deviceId: 'test-device-reconcile',
    })
    expect(deleted.status).toBe(200)
    expect(await (await request(`/v1/queue/requests/${id}/status`)).json()).toMatchObject({
      status: 'reconciling',
    })
    expect((await request(`/v1/queue/requests/${id}/input-image/0`)).status).toBe(200)
    expect(billing.settlements).toHaveLength(0)
  } finally {
    release()
    await running
  }
  await recoverTasksByIds([id])
  await runTask(id)
  expect(dispatches).toBe(1)
  expect(await (await operate(id)).json()).toMatchObject({
    status: 'reconciling',
    dispatches: [{ dispatchedAt: expect.any(Number) }],
  })
  expect(
    (
      await operate(id, 'POST', {
        commandId: 'deleted-conversation',
        operatorId: 'operator',
        evidence: 'Provider confirmed absence after deletion',
        action: 'confirm_no_result',
      })
    ).status,
  ).toBe(200)
  expect(billing.settlements).toHaveLength(1)
})

it('quarantines a crashed dispatch intent even when transport start was never recorded', async () => {
  const submitted = await request('/v1/queue/openai-compat/gpt-image-2/submit', 'POST', {
    prompt: 'crash window',
    device_id: 'test-device-reconcile',
    client_request_id: crypto.randomUUID(),
  })
  const { request_id: id } = (await submitted.json()) as { request_id: string }
  await db.execute(sql`update tasks set reconciliation_required = true where id = ${id}`)
  const { claimTaskExecution } = await import('../../workers/task-execution')
  const execution = await claimTaskExecution(id)
  expect(execution).not.toBeNull()
  try {
    await execution!.recordDispatchIntent()
  } finally {
    execution!.release()
  }
  await recoverTasksByIds([id])
  await runTask(id)
  expect(await (await operate(id)).json()).toMatchObject({
    status: 'reconciling',
    dispatches: [{ intendedAt: expect.any(Number), dispatchedAt: null }],
  })
  expect(dispatches).toBe(0)
  expect(billing.settlements).toHaveLength(0)
})

it('requires deliverable evidence for manual success and preserves legacy HTTP task behavior', async () => {
  const submitted = await request('/v1/queue/openai-compat/gpt-image-2/submit', 'POST', {
    prompt: 'manual verification',
    device_id: 'test-device-reconcile',
    client_request_id: crypto.randomUUID(),
  })
  const { request_id: id } = (await submitted.json()) as { request_id: string }
  await db.execute(sql`update tasks set reconciliation_required = true where id = ${id}`)
  await runTask(id)
  const command = {
    commandId: 'manual-success',
    operatorId: 'operator',
    evidence: 'Provider export attached',
    action: 'confirm_success',
  }
  expect((await operate(id, 'POST', { ...command, result: { data: [] } })).status).toBe(400)
  expect(billing.settlements).toHaveLength(0)
  expect(
    await (
      await operate(id, 'POST', { ...command, result: { data: [{ b64_json: PNG_BASE64 }] } })
    ).json(),
  ).toMatchObject({ status: 'completed' })
  expect(billing.settlements).toHaveLength(1)
  const legacy = await request('/v1/queue/openai-compat/gpt-image-2/submit', 'POST', {
    prompt: 'legacy',
    device_id: 'test-device-reconcile',
    client_request_id: crypto.randomUUID(),
    reconciliation_required: true,
    reconciliationRequired: true,
  })
  const legacyId = ((await legacy.json()) as { request_id: string }).request_id
  await runTask(legacyId)
  expect(await (await request(`/v1/queue/requests/${legacyId}/status`)).json()).toMatchObject({
    status: 'failed',
  })
  expect(billing.settlements).toHaveLength(2)
})

it('fences a late operator after lease expiry and rejects concurrent conflicting commands', async () => {
  const submitted = await request('/v1/queue/openai-compat/gpt-image-2/submit', 'POST', {
    prompt: 'late recovery',
    device_id: 'test-device-reconcile',
    client_request_id: crypto.randomUUID(),
  })
  const { request_id: id } = (await submitted.json()) as { request_id: string }
  await db.execute(sql`update tasks set reconciliation_required = true where id = ${id}`)
  await runTask(id)
  let reached!: () => void
  let release!: () => void
  const archiving = new Promise<void>((resolve) => {
    reached = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  class PausedStore extends DurableFixture {
    override async write(key: string, bytes: Uint8Array, contentType: string) {
      if (key.includes('/reconciliation/')) {
        reached()
        await waiting
      }
      await super.write(key, bytes, contentType)
    }
  }
  setDurableMediaStoreForTesting(new PausedStore())
  const command = {
    commandId: 'old-operator',
    operatorId: 'first',
    evidence: 'Provider result',
    action: 'confirm_success',
    result: { data: [{ b64_json: PNG_BASE64 }] },
  }
  const late = operate(id, 'POST', command)
  await archiving
  try {
    expect(await (await operate(id, 'POST', command)).json()).toMatchObject({
      status: 'reconciling',
    })
    const replacement = {
      commandId: 'new-operator',
      operatorId: 'second',
      evidence: 'Provider revoked the result',
      action: 'confirm_no_result',
    }
    expect((await operate(id, 'POST', replacement)).status).toBe(409)
    await db.execute(
      sql`update tasks set lease_expires_at = now() - interval '1 second' where id = ${id}`,
    )
    expect(await (await operate(id, 'POST', replacement)).json()).toMatchObject({
      status: 'failed',
    })
  } finally {
    release()
  }
  expect((await late).status).toBe(409)
  expect(await (await request(`/v1/queue/requests/${id}/status`)).json()).toMatchObject({
    status: 'failed',
  })
  expect(billing.settlements).toHaveLength(1)
  expect(billing.settlements[0]).toMatchObject({ outcome: 'failed' })
})

it('keeps a partial fan-out unresolved when only one of two dispatched requests is queryable', async () => {
  let submits = 0
  let lookups = 0
  setUpstreamFetchForTesting(async (url) => {
    if (String(url).endsWith('/async')) {
      submits++
      if (submits === 1)
        return new Response(JSON.stringify({ task_id: 'imgtask_known', status: 'processing' }), {
          status: 202,
        })
      throw new Error('second request accepted but response lost')
    }
    lookups++
    return new Response(
      JSON.stringify({ status: 'completed', result: { data: [{ b64_json: PNG_BASE64 }] } }),
    )
  })
  const submitted = await request('/v1/queue/openai-compat/gpt-image-2/submit', 'POST', {
    prompt: 'two cats',
    n: 2,
    device_id: 'test-device-reconcile',
    client_request_id: crypto.randomUUID(),
  })
  expect(submitted.status).toBe(200)
  const { request_id: id } = (await submitted.json()) as { request_id: string }
  await db.execute(sql`update tasks set reconciliation_required = true where id = ${id}`)
  await runTask(id)
  expect(await (await operate(id)).json()).toMatchObject({
    status: 'reconciling',
    upstreamTaskIds: ['imgtask_known'],
  })
  const response = await operate(id, 'POST', {
    commandId: 'partial-lookup',
    operatorId: 'operator',
    action: 'lookup',
    evidence: 'Check every original provider request',
  })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ status: 'reconciling' })
  expect(submits).toBe(2)
  expect(lookups).toBe(1)
  expect(billing.settlements).toHaveLength(0)
})
