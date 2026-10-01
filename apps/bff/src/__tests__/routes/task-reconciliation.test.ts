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
      sql`update tasks set lease_expires_at = ${new Date(Date.now() - 60_000).toISOString()}::timestamptz where id = ${id}`,
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

it.each([
  'b64',
  'url',
  'oversized-b64',
  'oversized-url',
] as const)('keeps non-cloud %s reconciliation unresolved when claimed image bytes are not decodable', async (source) => {
  const { config } = await import('../../config')
  const syncEnabled = config.operator.capabilities['accounts:sync']
  Object.assign(config.operator.capabilities, { 'accounts:sync': false })
  const maximumBytes = config.operator.quotas['sync:asset-image-bytes']
  const oversized = source.startsWith('oversized')
  const fromUrl = source.endsWith('url')
  const bytes = oversized ? Buffer.from(PNG_BASE64, 'base64') : Buffer.from('not-an-image')
  if (oversized) Object.assign(config.operator.quotas, { 'sync:asset-image-bytes': 32 })
  const download = fromUrl
    ? spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(bytes, { headers: { 'content-type': 'image/png' } }),
      )
    : undefined
  try {
    const submitted = await request('/v1/queue/openai-compat/gpt-image-2/submit', 'POST', {
      prompt: 'invalid recovered image',
      device_id: 'test-device-reconcile',
      client_request_id: crypto.randomUUID(),
    })
    expect(submitted.status).toBe(200)
    const { request_id: id } = (await submitted.json()) as { request_id: string }
    await db.execute(sql`update tasks set reconciliation_required = true where id = ${id}`)
    await runTask(id)
    const response = await operate(id, 'POST', {
      commandId: 'invalid-image-result',
      operatorId: 'operator',
      action: 'confirm_success',
      evidence: 'Provider exported this alleged image',
      result: {
        data: [
          fromUrl
            ? { url: 'https://provider.example/result.png' }
            : { b64_json: bytes.toString('base64') },
        ],
      },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'reconciling' })
    expect(billing.settlements).toHaveLength(0)
    expect(dispatches).toBe(1)
  } finally {
    download?.mockRestore()
    Object.assign(config.operator.capabilities, { 'accounts:sync': syncEnabled })
    Object.assign(config.operator.quotas, { 'sync:asset-image-bytes': maximumBytes })
  }
})

it.each([
  true,
  false,
])('preserves an unknown fan-out outcome after a definite rejection (async=%s)', async (asyncTasks) => {
  const { config } = await import('../../config')
  const previousAsync = config.upstream.asyncImageTasks
  config.upstream.asyncImageTasks = asyncTasks
  try {
    let submits = 0
    setUpstreamFetchForTesting(async () => {
      submits++
      if (submits === 1)
        return new Response(JSON.stringify({ error: { message: 'bad first request' } }), {
          status: 400,
        })
      throw new Error('second request accepted but connection lost')
    })
    const submitted = await request('/v1/queue/openai-compat/gpt-image-2/submit', 'POST', {
      prompt: 'mixed fanout failure',
      n: 2,
      device_id: 'test-device-reconcile',
      client_request_id: crypto.randomUUID(),
    })
    expect(submitted.status).toBe(200)
    const { request_id: id } = (await submitted.json()) as { request_id: string }
    await db.execute(sql`update tasks set reconciliation_required = true where id = ${id}`)
    await runTask(id)
    expect(await (await operate(id)).json()).toMatchObject({ status: 'reconciling' })
    await recoverTasksByIds([id])
    await runTask(id)
    expect(submits).toBe(2)
    expect(billing.settlements).toHaveLength(0)
  } finally {
    config.upstream.asyncImageTasks = previousAsync
  }
})

it('retains a completed synchronous sibling when another submission is definitely rejected', async () => {
  const { config } = await import('../../config')
  const previousAsync = config.upstream.asyncImageTasks
  config.upstream.asyncImageTasks = false
  try {
    let submits = 0
    setUpstreamFetchForTesting(async () => {
      submits++
      if (submits === 1)
        return Response.json({ error: { message: 'first request rejected' } }, { status: 400 })
      return Response.json({ data: [{ b64_json: PNG_BASE64 }] })
    })
    const submitted = await request('/v1/queue/openai-compat/gpt-image-2/submit', 'POST', {
      prompt: 'one rejected one completed',
      n: 2,
      device_id: 'test-device-reconcile',
      client_request_id: crypto.randomUUID(),
    })
    expect(submitted.status).toBe(200)
    const { request_id: id } = (await submitted.json()) as { request_id: string }
    await db.execute(sql`update tasks set reconciliation_required = true where id = ${id}`)
    await runTask(id)
    expect(await (await operate(id)).json()).toMatchObject({ status: 'reconciling' })
    await recoverTasksByIds([id])
    await runTask(id)
    expect(submits).toBe(2)
    expect(billing.settlements).toHaveLength(0)
  } finally {
    config.upstream.asyncImageTasks = previousAsync
  }
})

it('retains an accepted asynchronous sibling when another submission is definitely rejected', async () => {
  let submits = 0
  let lookups = 0
  setUpstreamFetchForTesting(async (url) => {
    if (String(url).endsWith('/async')) {
      submits++
      if (submits === 1)
        return Response.json({ error: { message: 'first request rejected' } }, { status: 400 })
      return Response.json(
        { task_id: 'imgtask_accepted_sibling', status: 'processing' },
        { status: 202 },
      )
    }
    lookups++
    return Response.json({ status: 'completed', result: { data: [{ b64_json: PNG_BASE64 }] } })
  })
  const submitted = await request('/v1/queue/openai-compat/gpt-image-2/submit', 'POST', {
    prompt: 'one rejected one accepted',
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
    upstreamTaskIds: ['imgtask_accepted_sibling'],
  })
  expect(billing.settlements).toHaveLength(0)
  await recoverTasksByIds([id])
  await runTask(id)
  const checked = await operate(id, 'POST', {
    commandId: 'query-accepted-sibling',
    operatorId: 'operator',
    action: 'lookup',
    evidence: 'Query the accepted request before final resolution',
  })
  expect(checked.status).toBe(200)
  expect(await checked.json()).toMatchObject({ status: 'reconciling' })
  expect(submits).toBe(2)
  expect(lookups).toBe(1)
  expect(billing.settlements).toHaveLength(0)
})

it.each([
  'recovery',
  'lookup',
] as const)('delivers a durable archive checkpoint through %s without asking the provider again', async (path) => {
  const submitted = await request('/v1/queue/openai-compat/gpt-image-2/submit', 'POST', {
    prompt: 'already archived result',
    device_id: 'test-device-reconcile',
    client_request_id: crypto.randomUUID(),
  })
  const { request_id: id } = await submitted.json()
  await db.execute(sql`update tasks set reconciliation_required = true where id = ${id}`)
  const { claimTaskExecution } = await import('../../workers/task-execution')
  const { spoolGenerationOutputs } = await import('../../lib/generationMedia')
  const execution = await claimTaskExecution(id)
  expect(execution).not.toBeNull()
  try {
    await execution!.recordDispatchIntent()
    const checkpoint = await spoolGenerationOutputs(
      id,
      'openai-compat',
      { data: [{ b64_json: PNG_BASE64 }] },
      undefined,
      execution!.signal,
    )
    expect(await execution!.saveCheckpoint(checkpoint)).toBe(true)
    if (path === 'lookup') await execution!.reconcile('worker lost the final response')
  } finally {
    execution!.release()
  }
  if (path === 'recovery') {
    expect(await recoverTasksByIds([id])).toMatchObject({ requeued: 1 })
    await runTask(id)
  } else {
    const checked = await operate(id, 'POST', {
      commandId: 'checkpoint-lookup',
      operatorId: 'operator',
      action: 'lookup',
      evidence: 'Inspect the already saved original',
    })
    expect(checked.status).toBe(200)
    expect(await checked.json()).toMatchObject({ status: 'completed' })
  }
  expect(await (await request(`/v1/queue/requests/${id}/status`)).json()).toMatchObject({
    status: 'completed',
  })
  const original = await request(`/v1/queue/requests/${id}/image/0`)
  expect(original.status).toBe(200)
  expect(new Uint8Array(await original.arrayBuffer())).toEqual(
    new Uint8Array(Buffer.from(PNG_BASE64, 'base64')),
  )
  expect(dispatches).toBe(0)
  expect(billing.settlements).toHaveLength(1)
  expect(billing.settlements[0]).toMatchObject({
    taskId: id,
    outcome: 'completed',
    upstreamInvocationCount: 1,
  })
})

it('keeps a provider task ID arriving after cancellation as evidence without letting the old executor settle', async () => {
  let release!: () => void
  let reached!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    reached = resolve
  })
  let submissions = 0
  let lookups = 0
  setUpstreamFetchForTesting(async (url) => {
    if (String(url).endsWith('/async')) {
      submissions++
      reached()
      await waiting
      return Response.json({ task_id: 'imgtask_late_reply', status: 'processing' }, { status: 202 })
    }
    lookups++
    expect(String(url)).toContain('imgtask_late_reply')
    return Response.json({ status: 'completed', result: { data: [{ b64_json: PNG_BASE64 }] } })
  })
  const submitted = await request('/v1/queue/openai-compat/gpt-image-2/submit', 'POST', {
    prompt: 'late submit acknowledgement',
    device_id: 'test-device-reconcile',
    client_request_id: crypto.randomUUID(),
  })
  const { request_id: id } = await submitted.json()
  await db.execute(sql`update tasks set reconciliation_required = true where id = ${id}`)
  const running = runTask(id)
  await started
  try {
    expect(await (await request(`/v1/queue/requests/${id}/cancel`, 'PUT')).json()).toMatchObject({
      status: 'reconciling',
    })
  } finally {
    release()
    await running
  }
  expect(await (await operate(id)).json()).toMatchObject({
    status: 'reconciling',
    upstreamTaskIds: ['imgtask_late_reply'],
    dispatches: [{ upstreamTaskId: 'imgtask_late_reply' }],
  })
  expect(billing.settlements).toHaveLength(0)
  const result = await operate(id, 'POST', {
    commandId: 'late-id-lookup',
    operatorId: 'operator',
    action: 'lookup',
    evidence: 'Query the late accepted provider ID',
  })
  expect(await result.json()).toMatchObject({ status: 'completed' })
  expect(submissions).toBe(1)
  expect(lookups).toBe(1)
  expect(billing.settlements).toHaveLength(1)
})

it('replays the original unresolved reason for the same reconciliation command', async () => {
  const submitted = await request('/v1/queue/openai-compat/gpt-image-2/submit', 'POST', {
    prompt: 'unknown outcome',
    device_id: 'test-device-reconcile',
    client_request_id: crypto.randomUUID(),
  })
  const { request_id: id } = await submitted.json()
  await db.execute(sql`update tasks set reconciliation_required = true where id = ${id}`)
  await runTask(id)
  const command = {
    commandId: 'same-lookup',
    operatorId: 'operator',
    action: 'lookup',
    evidence: 'Check the original attempt',
  }
  const first = await (await operate(id, 'POST', command)).json()
  expect(first).toEqual({
    taskId: id,
    status: 'reconciling',
    reason: 'manual_verification_required',
  })
  expect(await (await operate(id, 'POST', command)).json()).toEqual(first)
  expect(dispatches).toBe(1)
  expect(billing.settlements).toHaveLength(0)
})

it('queries the original ID when a durable archive checkpoint has lost its object', async () => {
  const durable = new DurableFixture()
  setDurableMediaStoreForTesting(durable)
  const submitted = await request('/v1/queue/openai-compat/gpt-image-2/submit', 'POST', {
    prompt: 'missing checkpoint object',
    device_id: 'test-device-reconcile',
    client_request_id: crypto.randomUUID(),
  })
  const { request_id: id } = await submitted.json()
  await db.execute(sql`update tasks set reconciliation_required = true where id = ${id}`)
  const { claimTaskExecution } = await import('../../workers/task-execution')
  const { spoolGenerationOutputs } = await import('../../lib/generationMedia')
  const execution = await claimTaskExecution(id)
  expect(execution).not.toBeNull()
  try {
    await execution!.recordDispatchIntent()
    await execution!.recordUpstreamTaskIds(['imgtask_lost_checkpoint'], false)
    const checkpoint = await spoolGenerationOutputs(
      id,
      'openai-compat',
      { data: [{ b64_json: PNG_BASE64 }] },
      undefined,
      execution!.signal,
    )
    expect(await execution!.saveCheckpoint(checkpoint)).toBe(true)
    durable.objects.clear()
    await execution!.reconcile('checkpoint object disappeared')
  } finally {
    execution!.release()
  }
  const urls: string[] = []
  setUpstreamFetchForTesting(async (url) => {
    urls.push(String(url))
    return Response.json({ status: 'completed', result: { data: [{ b64_json: PNG_BASE64 }] } })
  })
  const checked = await operate(id, 'POST', {
    commandId: 'lookup-lost-checkpoint',
    operatorId: 'operator',
    action: 'lookup',
    evidence: 'Restore original accepted request',
  })
  expect(await checked.json()).toMatchObject({ status: 'completed' })
  expect(urls).toHaveLength(1)
  expect(urls[0]).toContain('imgtask_lost_checkpoint')
  expect(urls[0]).not.toEndWith('/async')
  expect(billing.settlements).toHaveLength(1)
  expect((await request(`/v1/queue/requests/${id}/image/0`)).status).toBe(200)
})

it.each([
  'aggregate-evidence',
  'partial-fanout',
] as const)('quarantines a legacy task with accepted upstream evidence after %s failure', async (mode) => {
  let submits = 0
  setUpstreamFetchForTesting(async (url) => {
    if (!String(url).endsWith('/async'))
      throw new Error('must not poll during uncertain submission')
    submits++
    return submits === 1
      ? Response.json({ task_id: 'imgtask_legacy_accepted', status: 'processing' }, { status: 202 })
      : Response.json({ error: { message: 'second request refused' } }, { status: 500 })
  })
  if (mode === 'aggregate-evidence') {
    await db.execute(
      sql`CREATE FUNCTION reject_dispatch_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture dispatch identity persistence failure'; END $$`,
    )
    await db.execute(
      sql`CREATE TRIGGER reject_dispatch_identity BEFORE UPDATE ON tasks FOR EACH ROW WHEN (NEW.upstream_task_ids IS NOT NULL) EXECUTE FUNCTION reject_dispatch_identity()`,
    )
  }
  try {
    const submitted = await request('/v1/queue/openai-compat/gpt-image-2/submit', 'POST', {
      prompt: 'accepted legacy request',
      n: mode === 'partial-fanout' ? 2 : 1,
      device_id: 'test-device-reconcile',
      client_request_id: crypto.randomUUID(),
    })
    expect(submitted.status).toBe(200)
    const { request_id: id } = await submitted.json()
    expect(await (await operate(id)).json()).toMatchObject({ enabled: false })
    await runTask(id)
    expect(await (await operate(id)).json()).toMatchObject({
      enabled: true,
      status: 'reconciling',
      upstreamTaskIds: mode === 'partial-fanout' ? ['imgtask_legacy_accepted'] : [],
    })
    expect(billing.settlements).toHaveLength(0)
    await recoverTasksByIds([id])
    await runTask(id)
    expect(submits).toBe(mode === 'partial-fanout' ? 2 : 1)
    expect(billing.settlements).toHaveLength(0)
  } finally {
    if (mode === 'aggregate-evidence') {
      await db.execute(sql`DROP TRIGGER reject_dispatch_identity ON tasks`)
      await db.execute(sql`DROP FUNCTION reject_dispatch_identity()`)
    }
  }
})
