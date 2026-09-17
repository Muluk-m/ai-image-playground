import { afterAll, afterEach, beforeEach, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  _setPrivateBffOverlayForTesting,
  EMPTY_PRIVATE_BFF_OVERLAY,
} from '../../lib/private-overlay'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

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
let deviceA: string
let deviceB: string
let stranger: string
beforeEach(async () => {
  setObjectStoreForTesting(new InMemoryObjectStore())
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
  const { purgeOldTasks } = await import('../../db/maintenance')
  setUpstreamFetchForTesting(
    (async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              b64_json:
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=',
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
