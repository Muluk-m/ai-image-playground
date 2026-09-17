import { afterAll, afterEach, beforeEach, expect, it, spyOn } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import {
  _setPrivateBffOverlayForTesting,
  EMPTY_PRIVATE_BFF_OVERLAY,
} from '../../lib/private-overlay'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { stubGlobalFetch } from '../helpers/upstreamStubs'

_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'fixture'
process.env.DATABASE_URL = await resetTestDatabase('cloud_generations')
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../projects-operator-config.json')
const { app } = await import('../../app')
const { db, schema, close } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { runTask } = await import('../../workers/task-runner')
const { setUpstreamFetchForTesting } = await import('../../lib/upstream')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { setDurableMediaStoreForTesting } = await import('../../lib/durableMediaStore')
class DurableFixture extends InMemoryObjectStore {
  interruptNextWrite = false
  publicationUnavailable = false
  publicationFailuresRemaining = 0
  oversizedSpool = false
  afterWrite?: (key: string) => void
  spoolReads = 0
  override async read(key: string) {
    if (key.includes('/out/')) this.spoolReads++
    return super.read(key)
  }
  override async open(key: string) {
    const object = await super.open(key)
    return this.oversizedSpool && key.includes('/out/')
      ? { ...object, size: Number.MAX_SAFE_INTEGER }
      : object
  }
  override async write(key: string, bytes: Uint8Array, contentType: string) {
    if (this.interruptNextWrite && key.startsWith('staging/')) {
      this.interruptNextWrite = false
      throw new DOMException('Worker stopped', 'AbortError')
    }
    if (this.publicationUnavailable && key.startsWith('objects/'))
      throw new Error('publication unavailable')
    if (this.publicationFailuresRemaining > 0 && key.startsWith('objects/')) {
      this.publicationFailuresRemaining--
      throw new Error('publication failed')
    }
    await super.write(key, bytes, contentType)
    this.afterWrite?.(key)
  }
  sign(key: string) {
    return `https://durable.example/${key}`
  }
}
let durable: DurableFixture
let deviceA: string
let deviceB: string
let stranger: string
beforeEach(async () => {
  setObjectStoreForTesting(new InMemoryObjectStore())
  durable = new DurableFixture()
  setDurableMediaStoreForTesting(durable)
  await db.delete(schema.tasks)
  await db.delete(schema.users)
  for (const id of ['owner', 'stranger']) {
    await db.insert(schema.users).values({
      id,
      username: id,
      password_hash: 'fixture',
      status: 'active',
      created_at: 1,
      updated_at: 1,
    })
  }
  const session = async (userId: string) =>
    `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession(userId, tx))}`
  deviceA = await session('owner')
  deviceB = await session('owner')
  stranger = await session('stranger')
})
afterEach(() => {
  setUpstreamFetchForTesting()
  setObjectStoreForTesting()
  setDurableMediaStoreForTesting()
})
afterAll(close)
function request(path: string, cookie: string, body?: unknown) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { cookie, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  )
}
const input = {
  prompt: 'Cloud history fixture',
  device_id: 'generation-device-a',
  client_request_id: 'generation-command-1',
}
it('另一设备能发现新图片任务，其他用户不能读取', async () => {
  const submitted = await request('/v1/queue/openai-compat/gpt-image-2/submit', deviceA, input)
  expect(submitted.status).toBe(200)
  const task = await submitted.json()
  const listed = await request('/api/generations?limit=1', deviceB)
  expect(listed.status).toBe(200)
  expect(await listed.json()).toMatchObject({
    items: [{ id: task.request_id, model: 'gpt-image-2', status: 'queued' }],
    nextCursor: null,
  })
  const detail = await request(`/api/generations/${task.request_id}`, deviceB)
  expect(detail.status).toBe(200)
  expect(await detail.json()).toMatchObject({
    id: task.request_id,
    prompt: input.prompt,
    status: 'queued',
  })
  expect((await request(`/api/generations/${task.request_id}`, stranger)).status).toBe(404)
  expect(await (await request('/api/generations', stranger)).json()).toMatchObject({ items: [] })
})

it('丢失响应后重试返回原任务，换参数不能复用同一命令', async () => {
  const original = await (
    await request('/v1/queue/openai-compat/gpt-image-2/submit', deviceA, input)
  ).json()
  const retried = await request('/v1/queue/openai-compat/gpt-image-2/submit', deviceB, {
    ...input,
    device_id: 'generation-device-b',
  })
  expect(retried.status).toBe(200)
  expect((await retried.json()).request_id).toBe(original.request_id)
  const changed = await request('/v1/queue/openai-compat/gpt-image-2/submit', deviceB, {
    ...input,
    prompt: 'Different image',
  })
  expect(changed.status).toBe(409)
  expect(await changed.json()).toMatchObject({ error: 'idempotency_key_conflict' })
  expect((await (await request('/api/generations', deviceB)).json()).items).toHaveLength(1)
})

it('升级前的带参考图任务也校验原参数并保留永久重试回执', async () => {
  const legacyInput = {
    ...input,
    input_images: ['data:image/png;base64,aGVsbG8='],
  }
  const original = await (
    await request('/v1/queue/openai-compat/gpt-image-2/submit', deviceA, legacyInput)
  ).json()
  // Simulate a task written before command receipts existed.
  await db.delete(schema.generation_commands)
  const { finishTask } = await import('../../db/task-transitions')
  const { claimQueuedTask } = await import('../../db/claim-task')
  const { purgeOldTasks } = await import('../../db/maintenance')
  await claimQueuedTask(db, original.request_id, Date.now())
  expect(await finishTask(original.request_id, { status: 'failed', completedAt: Date.now() })).toBe(
    true,
  )
  expect(await purgeOldTasks(-1)).toBe(0)
  const changed = await request('/v1/queue/openai-compat/gpt-image-2/submit', deviceB, {
    ...legacyInput,
    prompt: 'Different legacy image',
  })
  expect(changed.status).toBe(409)
  const replay = await request('/v1/queue/openai-compat/gpt-image-2/submit', deviceB, {
    ...legacyInput,
    device_id: 'device-b',
  })
  expect(replay.status).toBe(200)
  expect((await replay.json()).request_id).toBe(original.request_id)
  expect(await purgeOldTasks(-1)).toBe(1)
  const afterPurge = await request(
    '/v1/queue/openai-compat/gpt-image-2/submit',
    deviceB,
    legacyInput,
  )
  expect(afterPurge.status).toBe(200)
  expect((await afterPurge.json()).request_id).toBe(original.request_id)
  expect(await db.select().from(schema.tasks)).toHaveLength(0)
})

it('旧任务参考图不可读时保留原任务，不把重试变成新生成', async () => {
  const { objectStore } = await import('../../lib/objectStore')
  const legacyInput = { ...input, input_images: ['data:image/png;base64,aGVsbG8='] }
  const original = await (
    await request('/v1/queue/openai-compat/gpt-image-2/submit', deviceA, legacyInput)
  ).json()
  await db.delete(schema.generation_commands)
  await objectStore().deletePrefix(`${original.request_id}/`)
  const retried = await request('/v1/queue/openai-compat/gpt-image-2/submit', deviceB, legacyInput)
  expect(retried.status).toBe(503)
  expect(await db.select({ id: schema.tasks.id }).from(schema.tasks)).toEqual([
    { id: original.request_id },
  ])
})

it('另一设备取消任务后，两台设备都读取到同一终态', async () => {
  const { request_id: id } = await (
    await request('/v1/queue/openai-compat/gpt-image-2/submit', deviceA, input)
  ).json()
  const cancelled = await app.handle(
    new Request(`http://localhost/v1/queue/requests/${id}/cancel`, {
      method: 'PUT',
      headers: { cookie: deviceB },
    }),
  )
  expect(cancelled.status).toBe(200)
  expect(await (await request(`/api/generations/${id}`, deviceA)).json()).toMatchObject({
    status: 'cancelled',
    revision: '2',
  })
  expect(await (await request(`/api/generations/${id}`, deviceB)).json()).toMatchObject({
    status: 'cancelled',
  })
})

it('另一设备看到任务开始，完成后的晚到结果不能覆盖取消', async () => {
  const started = Promise.withResolvers<void>()
  const result = Promise.withResolvers<Response>()
  setUpstreamFetchForTesting((async () => {
    started.resolve()
    return result.promise
  }) as NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>)
  const { request_id: id } = await (
    await request('/v1/queue/openai-compat/gpt-image-2/submit', deviceA, input)
  ).json()
  const running = runTask(id)
  await started.promise
  try {
    expect(await (await request(`/api/generations/${id}`, deviceB)).json()).toMatchObject({
      status: 'in_progress',
      revision: '2',
    })
    await app.handle(
      new Request(`http://localhost/v1/queue/requests/${id}/cancel`, {
        method: 'PUT',
        headers: { cookie: deviceB },
      }),
    )
  } finally {
    result.resolve(
      new Response(JSON.stringify({ error: { message: 'fixture failure' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await running
  }
  expect(await (await request(`/api/generations/${id}`, deviceA)).json()).toMatchObject({
    status: 'cancelled',
    revision: '3',
  })
})

it('生成失败在另一设备保留终态和完成时间', async () => {
  setUpstreamFetchForTesting(
    (async () =>
      new Response(JSON.stringify({ error: { message: 'fixture rejected' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })) as NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>,
  )
  const { request_id: id } = await (
    await request('/v1/queue/openai-compat/gpt-image-2/submit', deviceA, input)
  ).json()
  await runTask(id)
  const detail = await (await request(`/api/generations/${id}`, deviceB)).json()
  expect(detail).toMatchObject({ status: 'failed', revision: '3' })
  expect(detail.completedAt).toBeGreaterThanOrEqual(detail.startedAt)
})

it('暂时失败回队后，其他设备看到可重试状态', async () => {
  setUpstreamFetchForTesting(
    (async () =>
      new Response(JSON.stringify({ error: { message: 'busy' } }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })) as NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>,
  )
  const { request_id: id } = await (
    await request('/v1/queue/openai-compat/gpt-image-2/submit', deviceA, input)
  ).json()
  await runTask(id)
  expect(await (await request(`/api/generations/${id}`, deviceB)).json()).toMatchObject({
    status: 'queued',
    revision: '3',
    completedAt: null,
  })
})

it('worker 意外退出后，云端历史也结束任务', async () => {
  const { TaskScheduler } = await import('../../workers/task-scheduler')
  const { claimQueuedTask } = await import('../../db/claim-task')
  const entered = Promise.withResolvers<void>()
  const scheduler = new TaskScheduler({
    executeTask: async (id) => {
      await claimQueuedTask(db, id, Date.now())
      entered.resolve()
      throw new Error('fixture worker crash')
    },
  })
  const { request_id: id } = await (
    await request('/v1/queue/openai-compat/gpt-image-2/submit', deviceA, input)
  ).json()
  scheduler.start()
  try {
    await entered.promise
    await scheduler.waitForIdle(2000)
  } finally {
    scheduler.stop()
  }
  expect(await (await request(`/api/generations/${id}`, deviceB)).json()).toMatchObject({
    status: 'failed',
    revision: '3',
  })
})

it('完成记录与命令回执不会随临时任务过期而消失', async () => {
  const encoded = (
    await sharp({ create: { width: 1, height: 1, channels: 3, background: '#112233' } })
      .png()
      .toBuffer()
  ).toString('base64')
  const { purgeOldTasks } = await import('../../db/maintenance')
  setUpstreamFetchForTesting(
    (async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              b64_json: encoded,
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      )) as NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>,
  )
  const original = await (
    await request('/v1/queue/openai-compat/gpt-image-2/submit', deviceA, input)
  ).json()
  await runTask(original.request_id)
  expect(
    await (await request(`/api/generations/${original.request_id}`, deviceB)).json(),
  ).toMatchObject({ status: 'completed', revision: '3' })
  expect(await purgeOldTasks(-1)).toBe(1)
  const replay = await request('/v1/queue/openai-compat/gpt-image-2/submit', deviceB, input)
  expect(replay.status).toBe(200)
  expect((await replay.json()).request_id).toBe(original.request_id)
  expect((await (await request('/api/generations', deviceB)).json()).items).toMatchObject([
    { id: original.request_id, status: 'completed' },
  ])
})

it('分页游标拒绝超出日期范围的时间，不能变成服务端错误', async () => {
  const cursor = Buffer.from(
    JSON.stringify({ createdAt: 9007199254740991, id: '11111111-1111-4111-8111-111111111111' }),
  ).toString('base64url')
  expect((await request(`/api/generations?cursor=${cursor}`, deviceA)).status).toBe(400)
})

it('两台设备并发重发同一命令只创建一个任务和一次用户变更', async () => {
  const results = await Promise.all(
    [deviceA, deviceB, deviceA, deviceB].map(async (cookie) => {
      const response = await request('/v1/queue/openai-compat/gpt-image-2/submit', cookie, input)
      expect(response.status).toBe(200)
      return response.json()
    }),
  )
  expect(new Set(results.map((result) => result.request_id)).size).toBe(1)
  expect((await (await request('/api/generations', deviceB)).json()).items).toMatchObject([
    { id: results[0].request_id, revision: '1' },
  ])
  const different = await request('/v1/queue/openai-compat/gpt-image-2/submit', deviceB, {
    ...input,
    n: 2,
  })
  expect(different.status).toBe(409)
})

it('历史按有界页遍历，页面之间新提交不会造成重复或漏掉已有记录', async () => {
  const ids: string[] = []
  for (let i = 0; i < 5; i++) {
    const created = await (
      await request('/v1/queue/openai-compat/gpt-image-2/submit', deviceA, {
        ...input,
        client_request_id: `pagination-command-${i}`,
      })
    ).json()
    ids.push(created.request_id)
  }
  const first = await (await request('/api/generations?limit=2', deviceB)).json()
  expect(first.items).toHaveLength(2)
  await request('/v1/queue/openai-compat/gpt-image-2/submit', deviceA, {
    ...input,
    client_request_id: 'pagination-new-command',
  })
  const seen = first.items.map((item: { id: string }) => item.id)
  let cursor = first.nextCursor
  while (cursor) {
    const page = await (await request(`/api/generations?limit=2&cursor=${cursor}`, deviceB)).json()
    expect(page.items.length).toBeLessThanOrEqual(2)
    seen.push(...page.items.map((item: { id: string }) => item.id))
    cursor = page.nextCursor
  }
  expect(seen.sort()).toEqual(ids.sort())
  expect((await request('/api/generations?limit=101', deviceB)).status).not.toBe(200)
  expect((await request('/api/generations', '')).status).toBe(401)
})

it('没有项目的生成原件在临时任务清理后仍可跨设备读取', async () => {
  const original = await sharp({
    create: { width: 8, height: 6, channels: 3, background: '#77aa44' },
  })
    .png()
    .toBuffer()
  let calls = 0
  setUpstreamFetchForTesting((async () => {
    calls++
    return Response.json({ data: [{ b64_json: original.toString('base64') }] })
  }) as NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>)
  const submitted = await request('/v1/queue/openai-compat/gpt-image-2/submit', deviceA, input)
  const { request_id: id } = await submitted.json()
  await runTask(id)
  const detail = await (await request(`/api/generations/${id}`, deviceB)).json()
  expect(detail.status).toBe('completed')
  expect(detail.outputs).toHaveLength(1)
  const mediaId = detail.outputs[0].mediaId
  expect(detail.outputs[0]).toMatchObject({ index: 0, width: 8, height: 6 })
  const { objectStore } = await import('../../lib/objectStore')
  await objectStore().deletePrefix(`${id}/`)
  expect((await request(`/v1/queue/requests/${id}/output/0`, deviceB)).status).toBe(200)
  const { purgeOldTasks } = await import('../../db/maintenance')
  expect(await purgeOldTasks(-1)).toBe(1)
  const resumed = await request(`/v1/queue/requests/${id}/status`, deviceB)
  expect(resumed.status).toBe(200)
  expect(await resumed.json()).toMatchObject({
    status: 'completed',
    result: { images: [{ index: 0, mime: 'image/png' }] },
  })
  const retained = await (await request(`/api/generations/${id}`, deviceB)).json()
  expect(retained.outputs[0].mediaId).toBe(mediaId)
  const listing = await (await request('/api/generations', deviceB)).json()
  expect(listing.items[0].cover).toMatchObject({ mediaId, width: 8, height: 6 })
  expect(listing.items[0].outputs).toBeUndefined()
  expect(listing.items[0].parameters).toBeUndefined()
  const access = await request(`/api/media/${mediaId}/access`, deviceB)
  expect(access.status).toBe(200)
  const { originalUrl } = await access.json()
  expect(await durable.read(new URL(originalUrl).pathname.slice(1))).toEqual(
    new Uint8Array(original),
  )
  expect((await request(`/api/media/${mediaId}/access`, stranger)).status).toBe(404)
  const legacy = await request(`/v1/queue/requests/${id}`, deviceB)
  expect(legacy.status).toBe(200)
  expect((await legacy.json()).images).toHaveLength(1)
  const legacyImage = await request(`/v1/queue/requests/${id}/output/0`, deviceB)
  expect(legacyImage.status).toBe(200)
  expect(new Uint8Array(await legacyImage.arrayBuffer())).toEqual(new Uint8Array(original))
  expect((await request(`/v1/queue/requests/${id}/image/0`, stranger)).status).toBe(404)
  expect(calls).toBe(1)
})

it('原件归档中断后只恢复保存，不再次生成或丢失已生成图片', async () => {
  const original = await sharp({
    create: { width: 8, height: 6, channels: 3, background: '#559966' },
  })
    .png()
    .toBuffer()
  let calls = 0
  setUpstreamFetchForTesting((async () => {
    calls++
    return Response.json({ data: [{ b64_json: original.toString('base64') }] })
  }) as NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>)
  const { request_id: id } = await (
    await request('/v1/queue/openai-compat/gpt-image-2/submit', deviceA, input)
  ).json()
  durable.publicationFailuresRemaining = 1
  await runTask(id)
  expect(await (await request(`/api/generations/${id}`, deviceB)).json()).toMatchObject({
    status: 'queued',
  })
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000)
  try {
    await runTask(id)
  } finally {
    clock.mockRestore()
  }
  const detail = await (await request(`/api/generations/${id}`, deviceB)).json()
  expect(detail.status).toBe('completed')
  expect(detail.outputs).toHaveLength(1)
  expect(calls).toBe(1)
})

it('上游原图链接暂时不可读时只重取原图，不重新调用模型', async () => {
  const original = await sharp({
    create: { width: 8, height: 6, channels: 3, background: '#779944' },
  })
    .png()
    .toBuffer()
  let calls = 0
  setUpstreamFetchForTesting((async () => {
    calls++
    return Response.json({ data: [{ url: 'https://fixture.example/generated.png' }] })
  }) as NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>)
  let available = false
  const restore = stubGlobalFetch(() =>
    available ? new Response(original) : new Response('unavailable', { status: 503 }),
  )
  const { request_id: id } = await (
    await request('/v1/queue/openai-compat/gpt-image-2/submit', deviceA, input)
  ).json()
  try {
    await runTask(id)
    expect((await (await request(`/api/generations/${id}`, deviceB)).json()).status).toBe('queued')
    available = true
    const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000)
    try {
      await runTask(id)
    } finally {
      clock.mockRestore()
    }
    expect((await (await request(`/api/generations/${id}`, deviceB)).json()).status).toBe(
      'completed',
    )
    expect(calls).toBe(1)
  } finally {
    restore()
  }
})

it('worker 重启遇到已发出但无结果凭据的生成不会盲目再次提交', async () => {
  const { request_id: id } = await (
    await request('/v1/queue/openai-compat/gpt-image-2/submit', deviceA, input)
  ).json()
  // Persisted process-crash fixture: dispatch happened, no response or async receipt survived.
  await db
    .update(schema.tasks)
    .set({ status: 'in_progress', upstream_invocation_count: 1 })
    .where(eq(schema.tasks.id, id))
  const { recoverTasksByIds } = await import('../../db/maintenance')
  await recoverTasksByIds([id])
  expect((await (await request(`/api/generations/${id}`, deviceB)).json()).status).toBe('failed')
  const status = await request(`/v1/queue/requests/${id}/status`, deviceB)
  expect(await status.json()).toMatchObject({ error: { type: 'upstream_result_unknown' } })
})

it('临时数据清理后仍保留参考图、蒙版和可复用参数，不携带额外秘密字段', async () => {
  const png = await sharp({ create: { width: 8, height: 6, channels: 4, background: '#779944' } })
    .png()
    .toBuffer()
  const source = `data:image/png;base64,${png.toString('base64')}`
  setUpstreamFetchForTesting((async () =>
    Response.json({
      data: [{ b64_json: png.toString('base64') }],
      size: '8x6',
      quality: 'high',
    })) as NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>)
  const { request_id: id } = await (
    await request('/v1/queue/openai-compat/gpt-image-2/submit', deviceA, {
      ...input,
      input_images: [source],
      mask: source,
      quality: 'high',
      size: 'auto',
      n: 1,
      extra: { api_key: 'must-not-sync', response_format: 'b64_json' },
    })
  ).json()
  await runTask(id)
  const { purgeOldTasks } = await import('../../db/maintenance')
  expect(await purgeOldTasks(-1)).toBe(1)
  const detail = await (await request(`/api/generations/${id}`, deviceB)).json()
  expect(detail.inputs).toHaveLength(1)
  expect(detail.mask.mediaId).toBe(detail.inputs[0].mediaId)
  expect(detail.parameters).toMatchObject({ quality: 'high', size: 'auto', n: 1 })
  expect(detail.actualParameters).toMatchObject({ size: '8x6', quality: 'high' })
  expect(JSON.stringify(detail)).not.toContain('must-not-sync')
  for (const mediaId of [detail.inputs[0].mediaId, detail.mask.mediaId]) {
    const { originalUrl } = await (await request(`/api/media/${mediaId}/access`, deviceB)).json()
    expect(await durable.read(new URL(originalUrl).pathname.slice(1))).toEqual(new Uint8Array(png))
  }
})

it('归档重试下载成功后重启，即使原链接过期也能用已保存原件完成', async () => {
  const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#779944' } })
    .png()
    .toBuffer()
  let calls = 0
  setUpstreamFetchForTesting((async () => {
    calls++
    return Response.json({ data: [{ url: 'https://fixture.example/short-lived.png' }] })
  }) as NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>)
  let available = false
  const restore = stubGlobalFetch(() =>
    available ? new Response(png) : new Response('expired', { status: 403 }),
  )
  const { request_id: id } = await (
    await request('/v1/queue/openai-compat/gpt-image-2/submit', deviceA, input)
  ).json()
  try {
    await runTask(id)
    available = true
    durable.interruptNextWrite = true
    const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000)
    try {
      await runTask(id)
      available = false
      const { recoverTasksByIds } = await import('../../db/maintenance')
      await recoverTasksByIds([id])
      await runTask(id)
    } finally {
      clock.mockRestore()
    }
    expect((await (await request(`/api/generations/${id}`, deviceB)).json()).status).toBe(
      'completed',
    )
    expect(calls).toBe(1)
  } finally {
    restore()
  }
})

it('归档等待超过临时桶过期时间，生成原件、参考图和蒙版仍可恢复', async () => {
  const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#449977' } })
    .png()
    .toBuffer()
  const source = `data:image/png;base64,${png.toString('base64')}`
  let calls = 0
  setUpstreamFetchForTesting((async () => {
    calls++
    return Response.json({ data: [{ b64_json: png.toString('base64') }] })
  }) as NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>)
  const { request_id: id } = await (
    await request('/v1/queue/openai-compat/gpt-image-2/submit', deviceA, {
      ...input,
      input_images: [source],
      mask: source,
    })
  ).json()
  durable.publicationUnavailable = true
  await runTask(id)
  expect((await (await request(`/api/generations/${id}`, deviceB)).json()).status).toBe('queued')
  const { objectStore } = await import('../../lib/objectStore')
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 46 * 86_400_000)
  try {
    await objectStore().deletePrefix(`${id}/`)
    durable.publicationUnavailable = false
    await runTask(id)
  } finally {
    clock.mockRestore()
  }
  const detail = await (await request(`/api/generations/${id}`, deviceB)).json()
  expect(detail.status).toBe('completed')
  expect(detail.outputs).toHaveLength(1)
  expect(detail.inputs).toHaveLength(1)
  expect(detail.mask).not.toBeNull()
  expect(calls).toBe(1)
})

for (const provider of ['openai-compat', 'gemini'] as const) {
  it(`${provider} 已返回原图后首次存储短暂失败，只重试保存原响应`, async () => {
    const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#448877' } })
      .png()
      .toBuffer()
    let calls = 0
    setUpstreamFetchForTesting((async () => {
      calls++
      return Response.json(
        provider === 'openai-compat'
          ? { data: [{ b64_json: png.toString('base64') }] }
          : {
              candidates: [
                {
                  content: {
                    parts: [
                      { inlineData: { mimeType: 'image/png', data: png.toString('base64') } },
                    ],
                  },
                },
              ],
            },
      )
    }) as NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>)
    const submitted = await request(
      `/v1/queue/${provider}/${provider === 'gemini' ? 'gemini-3-pro-image-preview' : 'gpt-image-2'}/submit`,
      deviceA,
      input,
    )
    expect(submitted.status).toBe(200)
    const { request_id: id } = await submitted.json()
    durable.writeFailuresRemaining = 4
    await runTask(id)
    const detail = await (await request(`/api/generations/${id}`, deviceB)).json()
    expect(detail.status).toBe('completed')
    expect(detail.outputs).toHaveLength(1)
    const { originalUrl } = await (
      await request(`/api/media/${detail.outputs[0].mediaId}/access`, deviceB)
    ).json()
    expect(await durable.read(new URL(originalUrl).pathname.slice(1))).toEqual(new Uint8Array(png))
    expect(calls).toBe(1)
  })
}

it('归档读取先检查对象长度，拒绝超限原件时不整份缓冲且可恢复', async () => {
  const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#447766' } })
    .png()
    .toBuffer()
  let calls = 0
  setUpstreamFetchForTesting((async () => {
    calls++
    return Response.json({ data: [{ b64_json: png.toString('base64') }] })
  }) as NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>)
  const { request_id: id } = await (
    await request('/v1/queue/openai-compat/gpt-image-2/submit', deviceA, input)
  ).json()
  durable.oversizedSpool = true
  await runTask(id)
  expect((await (await request(`/api/generations/${id}`, deviceB)).json()).status).toBe('queued')
  expect(durable.spoolReads).toBe(0)
  durable.oversizedSpool = false
  const clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000)
  try {
    await runTask(id)
  } finally {
    clock.mockRestore()
  }
  expect((await (await request(`/api/generations/${id}`, deviceB)).json()).status).toBe('completed')
  expect(calls).toBe(1)
})

it('原件已写入但完成凭据尚未提交时重启，按原任务找回而不重新生成', async () => {
  const png = await sharp({ create: { width: 8, height: 6, channels: 3, background: '#779955' } })
    .png()
    .toBuffer()
  let calls = 0
  setUpstreamFetchForTesting((async () => {
    calls++
    return Response.json({ data: [{ b64_json: png.toString('base64') }] })
  }) as NonNullable<Parameters<typeof setUpstreamFetchForTesting>[0]>)
  const { request_id: id } = await (
    await request('/v1/queue/openai-compat/gpt-image-2/submit', deviceA, input)
  ).json()
  const { abortRunningTask } = await import('../../workers/task-runner')
  durable.afterWrite = (key) => {
    if (key === `${id}/out/0`) {
      abortRunningTask(id)
      throw new DOMException('Worker stopped after object write', 'AbortError')
    }
  }
  await runTask(id)
  durable.afterWrite = undefined
  const { recoverTasksByIds } = await import('../../db/maintenance')
  await recoverTasksByIds([id])
  await runTask(id)
  const detail = await (await request(`/api/generations/${id}`, deviceB)).json()
  expect(detail.status).toBe('completed')
  expect(detail.outputs).toHaveLength(1)
  expect(calls).toBe(1)
})
