import { afterAll, describe, expect, it } from 'bun:test'
import { createDb } from '@image-playground/db'
import { insertTestTasks, resetTestDatabase } from '@image-playground/db/testing'
import { todayWindow } from '../../../../contracts'
import { useMemoryLogSource } from '../helpers/memory-log-source'

process.env.DATABASE_URL = await resetTestDatabase('admin_today')
process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
const writer = createDb(process.env.DATABASE_URL)
const logSource = await useMemoryLogSource()
const from = Date.UTC(2026, 9, 1, 16)
const to = from + 3600_000
await writer.db.insert(writer.schema.users).values([
  { id: 'today-user', username: 'alice', password_hash: 'x', created_at: from, updated_at: from },
  {
    id: 'login-only',
    username: 'bob',
    password_hash: 'x',
    created_at: from,
    updated_at: from,
    last_login_at: to,
  },
])
await writer.db
  .insert(writer.schema.admin_user_notes)
  .values({ user_id: 'today-user', note: '设计师', updated_at: from })
const task = {
  provider: 'openai-compat' as const,
  model: 'gpt-image-2',
  request_payload: {
    prompt: 'draw',
    device_id: 'shared-device',
    input_images: [{ object: 'sensitive-base64', mime: 'image/png' }],
  },
  submitted_at: from + 1000,
}
await insertTestTasks(writer.db, [
  ...Array.from({ length: 101 }, (_, i) => ({
    ...task,
    id: `today-${String(i).padStart(3, '0')}`,
    user_id: 'today-user',
    status: 'completed' as const,
  })),
  {
    ...task,
    id: 'today-failed',
    user_id: 'today-user',
    status: 'failed',
    error_type: 'upstream_error',
    upstream_invocation_count: 2,
  },
  {
    ...task,
    id: 'today-failed-policy',
    user_id: 'today-user',
    status: 'failed',
    error_type: 'content_policy',
    submitted_at: from + 3000,
  },
  {
    ...task,
    id: 'today-failed-blank',
    user_id: 'today-user',
    status: 'failed',
    error_type: null,
    submitted_at: from + 2000,
  },
  {
    ...task,
    id: 'seedream',
    model: 'doubao-seedream',
    user_id: 'today-user',
    status: 'completed',
    upstream_invocation_count: 3,
  },
  {
    ...task,
    id: 'chat-hidden',
    kind: 'chat',
    user_id: 'today-user',
    status: 'failed',
    upstream_invocation_count: 9,
  },
  {
    ...task,
    id: 'anon',
    status: 'completed',
    provider: 'gemini',
    request_payload: {
      contents: [
        {
          parts: [
            { text: 'first' },
            { inlineData: { data: 'sensitive-base64', mimeType: 'image/png' } },
            { text: 'second' },
          ],
        },
      ],
      device_id: 'shared-device',
    } as never,
  },
  {
    ...task,
    id: 'unassigned',
    request_payload: { prompt: 'draw' },
    submitted_at: from,
    status: 'queued',
  },
  { ...task, id: 'yesterday', user_id: 'today-user', status: 'failed', submitted_at: from - 1 },
  { ...task, id: 'future', user_id: 'today-user', status: 'in_progress', submitted_at: to + 1 },
])
const log = {
  at: from + 2000,
  service: 'worker' as const,
  instance: 'instance',
  version: 'sha',
  event: 'generation.failed',
  group_key: 'generation.failed',
  message: 'error',
  task_id: 'today-failed',
  fields: { stack: 'redacted stack' },
}
logSource.insert([
  { ...log, id: 'error', level: 'error' },
  { ...log, id: 'fatal', level: 'fatal' },
  { ...log, id: 'warn', level: 'warn' },
  {
    ...log,
    id: 'legacy-stack',
    level: 'error',
    event: null,
    message: '    at getSchemaValidator (schema.ts:541:26)',
  },
  {
    ...log,
    id: 'full-terminal-error',
    level: 'error',
    event: null,
    message: 'TypeError: broken\n    at call (app.ts:1:2)',
  },
  { ...log, id: 'old-error', level: 'error', at: from - 1 },
])
await writer.db.insert(writer.schema.client_errors).values({
  id: 'client-error',
  fingerprint: 'aaaaaaaaaaaaaaaa',
  kind: 'boot',
  message: 'timeout',
  received_at: from + 3000,
})
const { app } = await import('../../../../server/app')
const { getTodayOverview, getGenerationTasks } = await import('../../../../server/lib/today')
afterAll(() => writer.close())
const login = await app.handle(
  new Request('http://localhost/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.230' },
    body: JSON.stringify({ password: 'test-pass-1234' }),
  }),
)
const cookie = login.headers.get('set-cookie')!.split(';')[0]!
const request = (path: string) =>
  app.handle(new Request(`http://localhost${path}`, { headers: { cookie } }))

describe('today generation overview', () => {
  it('counts all errors before limiting preview rows and excludes both sides of the selected window', async () => {
    const start = from + 6 * 86400_000
    const end = start + 3600_000
    await writer.db.insert(writer.schema.client_errors).values(
      Array.from({ length: 9 }, (_, i) => ({
        id: `activity-client-${i}`,
        fingerprint: 'cccccccccccccccc',
        kind: 'error' as const,
        message: 'client failure',
        received_at: i === 0 ? start - 1 : i === 8 ? end + 1 : start + i,
      })),
    )
    logSource.insert(
      Array.from({ length: 9 }, (_, i) => ({
        ...log,
        id: `activity-server-${i}`,
        level: 'error' as const,
        at: i === 0 ? start - 1 : i === 8 ? end + 1 : start + i,
      })),
    )
    const response = await request(`/api/overview/generation?from=${start}&to=${end}`)
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.activity.client.total).toBe(7)
    expect(data.activity.server.total).toBe(7)
    expect(data.activity.client.entries).toHaveLength(5)
    expect(data.activity.server.entries).toHaveLength(5)
    expect(data.activity.client.entries.map((entry: { id: string }) => entry.id)).toEqual(
      [7, 6, 5, 4, 3].map((i) => `activity-client-${i}`),
    )
    expect(data.activity.server.entries.map((entry: { id: string }) => entry.id)).toEqual(
      [7, 6, 5, 4, 3].map((i) => `activity-server-${i}`),
    )
    expect(data.activity.tasks).toEqual([])
  })

  it('lists generation owners and their problems for the exact selected rolling window', async () => {
    const response = await request(`/api/overview/generation?from=${from + 1500}&to=${to}`)
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.window).toEqual({ from: from + 1500, to })
    expect(data.summary).toMatchObject({ users: 1, devices: 0, tasks: 2, failed: 2 })
    expect(data.activity.window).toEqual(data.window)
    expect(data.activity.tasks.map((task: { id: string }) => task.id)).toEqual([
      'today-failed-policy',
      'today-failed-blank',
    ])
    expect(data.activity.server.total).toBe(3)
    expect(data.activity.client.total).toBe(1)
    expect(JSON.stringify(data.activity)).not.toContain('sensitive-base64')

    expect(data.actors).toEqual([
      expect.objectContaining({ id: 'today-user', username: 'alice', tasks: 2, failed: 2 }),
    ])
    const tasks = await request(
      `/api/tasks?from=${from + 1500}&to=${to}&userId=today-user&status=failed`,
    )
    expect((await tasks.json()).tasks.map((task: { id: string }) => task.id)).toEqual([
      'today-failed-policy',
      'today-failed-blank',
    ])
    for (const suffix of ['from=bad&to=1', `from=${from}&to=${from}`, `from=0&to=${to}`])
      expect((await request(`/api/overview/generation?${suffix}`)).status).toBe(400)
    expect(
      (
        await app.handle(
          new Request(`http://localhost/api/overview/generation?from=${from}&to=${to}`),
        )
      ).status,
    ).toBe(401)
  })

  it('uses Beijing midnight, counts generation owners rather than login activity, and assigns signed-in devices only to their user', async () => {
    expect(todayWindow(Date.UTC(2026, 9, 1, 23))).toEqual({ from, to: Date.UTC(2026, 9, 1, 23) })
    expect(todayWindow(from - 1).from).toBe(from - 86400_000)
    const data = await getTodayOverview(to)
    expect(data.summary).toMatchObject({
      users: 1,
      devices: 1,
      tasks: 107,
      completed: 103,
      failed: 3,
      queued: 1,
      in_progress: 0,
    })
    expect(data.models).toEqual([
      {
        model: 'gpt-image-2',
        tasks: 106,
        completed: 102,
        failed: 3,
        upstream_invocations: 2,
        failures: [
          { error_type: 'content_policy', count: 1 },
          { error_type: 'unknown', count: 1 },
          { error_type: 'upstream_error', count: 1 },
        ],
      },
      {
        model: 'doubao-seedream',
        tasks: 1,
        completed: 1,
        failed: 0,
        upstream_invocations: 3,
        failures: [],
      },
    ])
    expect(data.actors).toHaveLength(3)
    expect(data.actors.find((actor) => actor.kind === 'user')).toMatchObject({
      id: 'today-user',
      username: 'alice',
      note: '设计师',
      tasks: 105,
      failed: 3,
    })
    expect(data.actors.find((actor) => actor.kind === 'device')).toMatchObject({
      id: 'shared-device',
      tasks: 1,
    })
    expect(data.actors.find((actor) => actor.kind === 'unassigned')).toMatchObject({
      tasks: 1,
      last_submitted_at: from,
    })
    expect(await getTodayOverview(from - 86400_000)).toMatchObject({
      actors: [],
      models: [],
      summary: { tasks: 0 },
    })
  })

  it('keeps the exact snapshot window and filters through stable pagination, without returning input images', async () => {
    const first = await getGenerationTasks({ from, to, userId: 'today-user' })
    expect(first.tasks).toHaveLength(100)
    expect(first.nextCursor).not.toBeNull()
    const second = await getGenerationTasks({ from, to, userId: 'today-user' }, first.nextCursor!)
    expect(second.tasks).toHaveLength(5)
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.tasks, ...second.tasks].map((task) => task.id)).size).toBe(105)
    expect(JSON.stringify(first)).not.toContain('sensitive-base64')
    expect(
      (await getGenerationTasks({ from, to, deviceId: 'shared-device' })).tasks[0]?.prompt,
    ).toBe('first\nsecond')
    expect(
      (await getGenerationTasks({ from, to, userId: 'today-user', status: 'failed' })).tasks.map(
        (task) => task.id,
      ),
    ).toEqual(['today-failed-policy', 'today-failed-blank', 'today-failed'])
    expect(
      (await getGenerationTasks({ from, to, model: 'doubao-seedream' })).tasks.map(
        (task) => task.id,
      ),
    ).toEqual(['seedream'])
    expect(
      (await getGenerationTasks({ from, to, model: 'gpt-image-2', status: 'failed' })).tasks.map(
        (task) => task.id,
      ),
    ).toEqual(['today-failed-policy', 'today-failed-blank', 'today-failed'])
    expect(
      (await getGenerationTasks({ from, to, deviceId: 'shared-device' })).tasks.map(
        (task) => task.id,
      ),
    ).toEqual(['anon'])
    expect(
      (await getGenerationTasks({ from, to, unassigned: '1' })).tasks.map((task) => task.id),
    ).toEqual(['unassigned'])
    const paged = await getGenerationTasks({
      from,
      to,
      userId: 'today-user',
      page: 1,
      pageSize: 50,
    })
    expect(paged.tasks).toHaveLength(50)
    expect(paged.total).toBe(105)
    expect(paged.page).toBe(1)
    const byProvider = await getGenerationTasks({
      from,
      to,
      providers: ['openai-compat'],
      errorTypes: ['upstream_error'],
      page: 1,
      pageSize: 50,
    })
    expect(byProvider.tasks.map((task) => task.id)).toEqual(['today-failed'])
    const byName = await getGenerationTasks({ from, to, q: 'alice', page: 1, pageSize: 50 })
    expect(byName.total).toBeGreaterThan(0)
    expect(byName.tasks.every((task) => task.username === 'alice')).toBe(true)
  })

  it('requires authentication and rejects malformed time, identity, status and pagination filters', async () => {
    for (const path of ['/api/overview/today', '/api/tasks'])
      expect((await app.handle(new Request(`http://localhost${path}`))).status).toBe(401)
    for (const suffix of [
      'from=bad&to=1',
      `from=${from}&to=${from}`,
      'userId=a&deviceId=b',
      'userId=a&actorType=device',
      'status=nope',
      'statuses=failed,nope',
      'sources=chat,nope',
      'gptRoute=invalid',
      'httpBuckets=9xx',
      'actorType=bot',
      'sort=evil',
      'dir=sideways',
      `from=${from}&to=${to}&sort=run_ms`,
      `from=${from}&to=${to}&dir=asc`,
      'minDurationSec=60&maxDurationSec=10',
      `from=${from}&to=${to}&cursor=bad`,
      'unassigned=2',
      `model=${'m'.repeat(129)}`,
    ])
      expect((await request(`/api/tasks?${suffix}`)).status).toBe(400)
    expect(
      (await request(`/api/tasks?from=${from}&to=${to}&userId=today-user&status=failed`)).status,
    ).toBe(200)
    expect((await request('/api/overview/today')).status).toBe(200)
  })

  it('supports rich multi-facet filtering, sorting, summary percentiles, and window facets', async () => {
    const richFrom = from + 10 * 86400_000
    const richTo = richFrom + 3600_000
    await insertTestTasks(writer.db, [
      {
        ...task,
        id: 'rich-fast-direct',
        user_id: 'today-user',
        model: 'gpt-image-2.5-flare',
        provider: 'openai-compat',
        status: 'completed',
        gpt_route: 'direct',
        gpt_key_fingerprint: '0cc5815e',
        upstream_status: 200,
        attempt_count: 1,
        upstream_invocation_count: 1,
        submitted_at: richFrom + 10_000,
        started_at: richFrom + 11_000,
        completed_at: richFrom + 21_000, // run 10s, queue 1s
      },
      {
        ...task,
        id: 'rich-slow-sub2api',
        user_id: 'today-user',
        model: 'gpt-image-1.5',
        provider: 'openai-compat',
        status: 'completed',
        gpt_route: 'sub2api',
        upstream_status: 200,
        attempt_count: 2,
        upstream_invocation_count: 3,
        submitted_at: richFrom + 20_000,
        started_at: richFrom + 32_000, // queue 12s
        completed_at: richFrom + 82_000, // run 50s
      },
      {
        ...task,
        id: 'rich-fail-504',
        user_id: null,
        request_payload: { prompt: 'retry timeout', device_id: 'rich-dev-1' } as never,
        model: 'gemini-2.5-flash-image',
        provider: 'gemini',
        status: 'failed',
        error_type: 'upstream_timeout',
        upstream_status: 504,
        attempt_count: 3,
        upstream_invocation_count: 4,
        submitted_at: richFrom + 30_000,
        started_at: richFrom + 31_000,
        completed_at: richFrom + 95_000, // run 64s
      },
      {
        ...task,
        id: 'rich-reconciling',
        user_id: 'today-user',
        model: 'gpt-image-2.5-flare',
        provider: 'openai-compat',
        status: 'reconciling',
        reconciliation_required: true,
        gpt_route: 'direct',
        gpt_key_fingerprint: 'a91f30c2',
        upstream_status: 502,
        error_type: null,
        attempt_count: 2,
        upstream_invocation_count: 2,
        submitted_at: richFrom + 40_000,
        started_at: richFrom + 41_000,
        completed_at: null,
      },
    ])

    const byRunDesc = await getGenerationTasks({
      from: richFrom,
      to: richTo,
      page: 1,
      pageSize: 50,
      sort: 'run_ms',
      dir: 'desc',
    })
    expect(byRunDesc.tasks.map((item) => item.id)).toEqual([
      'rich-reconciling',
      'rich-fail-504',
      'rich-slow-sub2api',
      'rich-fast-direct',
    ])
    const byTotalDesc = await getGenerationTasks({
      from: richFrom,
      to: richTo,
      page: 1,
      pageSize: 50,
      sort: 'total_ms',
      dir: 'desc',
    })
    expect(byTotalDesc.tasks.map((item) => item.id)).toEqual([
      'rich-reconciling',
      'rich-fail-504',
      'rich-slow-sub2api',
      'rich-fast-direct',
    ])
    expect(byRunDesc.summary).toMatchObject({
      total: 4,
      completed: 2,
      failed: 1,
      reconciling: 1,
    })
    expect(byRunDesc.summary?.p50_run_ms).toBe(30_000)
    expect(byRunDesc.facets?.models.map((m) => m.value)).toEqual([
      'gpt-image-2.5-flare',
      'gemini-2.5-flash-image',
      'gpt-image-1.5',
    ])
    expect(byRunDesc.facets?.errorTypes).toEqual([
      { value: 'unknown', count: 1 },
      { value: 'upstream_timeout', count: 1 },
    ])

    // Multi-status filter preserves statusCounts across all statuses in facets
    const multiStatus = await getGenerationTasks({
      from: richFrom,
      to: richTo,
      statuses: ['failed', 'reconciling'],
      page: 1,
      pageSize: 50,
      sort: 'status',
      dir: 'asc',
    })
    expect(multiStatus.tasks.map((item) => item.id)).toEqual(['rich-reconciling', 'rich-fail-504'])
    expect(multiStatus.facets?.statusCounts).toMatchObject({
      completed: 2,
      failed: 1,
      reconciling: 1,
    })

    // Route, HTTP 5xx, retried, queue, duration range, actorType, fingerprint/short-id search
    expect(
      (
        await getGenerationTasks({
          from: richFrom,
          to: richTo,
          gptRoute: 'direct',
          page: 1,
          pageSize: 50,
        })
      ).tasks.map((item) => item.id),
    ).toEqual(['rich-reconciling', 'rich-fast-direct'])

    expect(
      (
        await getGenerationTasks({
          from: richFrom,
          to: richTo,
          httpBuckets: ['5xx'],
          retried: '1',
          page: 1,
          pageSize: 50,
          sort: 'attempt_count',
          dir: 'desc',
        })
      ).tasks.map((item) => item.id),
    ).toEqual(['rich-fail-504', 'rich-reconciling'])

    expect(
      (
        await getGenerationTasks({
          from: richFrom,
          to: richTo,
          minQueueSec: 5,
          minDurationSec: 30,
          maxDurationSec: 60,
          page: 1,
          pageSize: 50,
        })
      ).tasks.map((item) => item.id),
    ).toEqual(['rich-slow-sub2api'])

    expect(
      (
        await getGenerationTasks({
          from: richFrom,
          to: richTo,
          actorType: 'device',
          page: 1,
          pageSize: 50,
        })
      ).tasks.map((item) => item.id),
    ).toEqual(['rich-fail-504'])

    expect(
      (
        await getGenerationTasks({
          from: richFrom,
          to: richTo,
          q: '0cc5815e',
          page: 1,
          pageSize: 50,
        })
      ).tasks.map((item) => item.id),
    ).toEqual(['rich-fast-direct'])

    expect(
      (
        await getGenerationTasks({
          from: richFrom,
          to: richTo,
          errorTypes: ['unknown'],
          page: 1,
          pageSize: 50,
        })
      ).tasks.map((item) => item.id),
    ).toEqual(['rich-reconciling'])
  })
})
