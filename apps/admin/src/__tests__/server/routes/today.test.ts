import { afterAll, describe, expect, it } from 'bun:test'
import { createDb } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'
import { todayWindow } from '../../../../contracts'

process.env.DATABASE_URL = await resetTestDatabase('admin_today')
process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
const writer = createDb(process.env.DATABASE_URL)
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
await writer.db.insert(writer.schema.tasks).values([
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
await writer.db.insert(writer.schema.server_logs).values([
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
const { getTodayOverview, getGenerationTasks, getTodayErrors } = await import(
  '../../../../server/lib/today'
)
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
  it('uses Beijing midnight, counts generation owners rather than login activity, and assigns signed-in devices only to their user', async () => {
    expect(todayWindow(Date.UTC(2026, 9, 1, 23))).toEqual({ from, to: Date.UTC(2026, 9, 1, 23) })
    expect(todayWindow(from - 1).from).toBe(from - 86400_000)
    const data = await getTodayOverview(to)
    expect(data.summary).toMatchObject({
      users: 1,
      devices: 1,
      tasks: 105,
      completed: 103,
      failed: 1,
      queued: 1,
      in_progress: 0,
    })
    expect(data.models).toEqual([
      {
        model: 'gpt-image-2',
        tasks: 104,
        completed: 102,
        failed: 1,
        upstream_invocations: 2,
      },
      {
        model: 'doubao-seedream',
        tasks: 1,
        completed: 1,
        failed: 0,
        upstream_invocations: 3,
      },
    ])
    expect(data.actors).toHaveLength(3)
    expect(data.actors.find((actor) => actor.kind === 'user')).toMatchObject({
      id: 'today-user',
      username: 'alice',
      note: '设计师',
      tasks: 103,
      failed: 1,
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
    expect(second.tasks).toHaveLength(3)
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.tasks, ...second.tasks].map((task) => task.id)).size).toBe(103)
    expect(JSON.stringify(first)).not.toContain('sensitive-base64')
    expect(
      (await getGenerationTasks({ from, to, deviceId: 'shared-device' })).tasks[0]?.prompt,
    ).toBe('first\nsecond')
    expect(
      (await getGenerationTasks({ from, to, userId: 'today-user', status: 'failed' })).tasks.map(
        (task) => task.id,
      ),
    ).toEqual(['today-failed'])
    expect(
      (await getGenerationTasks({ from, to, model: 'doubao-seedream' })).tasks.map(
        (task) => task.id,
      ),
    ).toEqual(['seedream'])
    expect(
      (await getGenerationTasks({ from, to, model: 'gpt-image-2', status: 'failed' })).tasks.map(
        (task) => task.id,
      ),
    ).toEqual(['today-failed'])
    expect(
      (await getGenerationTasks({ from, to, deviceId: 'shared-device' })).tasks.map(
        (task) => task.id,
      ),
    ).toEqual(['anon'])
    expect(
      (await getGenerationTasks({ from, to, unassigned: '1' })).tasks.map((task) => task.id),
    ).toEqual(['unassigned'])
  })

  it('lists error and fatal server logs alongside frontend errors, excluding warnings and yesterday', async () => {
    const data = await getTodayErrors(to)
    expect(data.total).toBe(4)
    expect(data.entries[0]?.source).toBe('client')
    expect(data.entries.find((entry) => entry.id === 'error')).toMatchObject({
      task_id: 'today-failed',
      stack: 'redacted stack',
    })
    expect(data.entries.map((entry) => entry.id)).not.toContain('warn')
    expect(data.entries.map((entry) => entry.id)).not.toContain('legacy-stack')
    expect(data.entries.find((entry) => entry.id === 'full-terminal-error')).toMatchObject({
      instance: 'instance',
      message: 'TypeError: broken\n    at call (app.ts:1:2)',
    })
  })

  it('counts the full recent window before limiting rows and correlates request reasons without counting warnings', async () => {
    const now = to + 86400_000
    const failure = {
      ...log,
      service: 'bff' as const,
      event: 'http.request',
      message: 'API request failed',
      task_id: null,
      request_id: 'media-request',
      fields: { route: 'POST /api/media/:id/complete', status: 503 },
    }
    await writer.db.insert(writer.schema.server_logs).values([
      { ...failure, id: 'media-http', at: now - 20, level: 'error' },
      {
        ...failure,
        id: 'media-cause',
        at: now - 21,
        level: 'warn',
        event: 'media.request_rejected',
        fields: { errorCode: 'media_processing_busy', reason: 'object_lock_timeout' },
      },
      {
        ...failure,
        id: 'other-instance',
        instance: 'other',
        at: now - 19,
        level: 'warn',
        fields: { errorCode: 'wrong_instance', reason: 'wrong_instance' },
      },
      {
        ...failure,
        id: 'future-cause',
        at: now + 1,
        level: 'warn',
        fields: { errorCode: 'future_cause', reason: 'future_cause' },
      },
      { ...log, id: 'earlier-today', at: now - 3600_000 + 1000, level: 'error' },
      ...Array.from({ length: 12 }, (_, i) => ({
        ...log,
        id: `recent-${i}`,
        at: now - 100 - i,
        level: 'error' as const,
      })),
    ])
    const data = await getTodayErrors(now)
    expect(data.total).toBe(14)
    expect(data.recent?.total).toBe(13)
    expect(data.entries).toHaveLength(10)
    expect(data.recent?.entries).toHaveLength(10)
    expect(data.entries[0]).toMatchObject({
      id: 'media-http',
      route: 'POST /api/media/:id/complete',
      status: 503,
      errorCode: 'media_processing_busy',
      reason: 'object_lock_timeout',
    })
    expect(JSON.stringify(data)).not.toContain('wrong_instance')
    expect(JSON.stringify(data)).not.toContain('future_cause')
  })

  it('keeps recent errors from the previous day after midnight while today is empty', async () => {
    const midnight = from + 2 * 86400_000
    await writer.db.insert(writer.schema.client_errors).values({
      id: 'before-midnight',
      fingerprint: 'bbbbbbbbbbbbbbbb',
      kind: 'boot',
      message: 'timeout',
      received_at: midnight - 1,
    })
    const data = await getTodayErrors(midnight + 5 * 60_000)
    expect(data.total).toBe(0)
    expect(data.entries).toEqual([])
    expect(data.recent?.total).toBe(1)
    expect(data.recent?.entries[0]?.id).toBe('before-midnight')
    expect(data.recent?.window).toEqual({ from: midnight - 10 * 60_000, to: midnight + 5 * 60_000 })
    const empty = await getTodayErrors(midnight + 16 * 60_000)
    expect(empty.recent?.total).toBe(0)
    expect(empty.recent?.entries).toEqual([])
  })

  it('extracts string err from both the failure itself and correlated request logs', async () => {
    const now = to + 3 * 86400_000
    await writer.db.insert(writer.schema.server_logs).values([
      {
        ...log,
        id: 'batch-error-string',
        at: now - 1,
        level: 'error',
        message: 'batch dispatch failed',
        fields: { err: 'Dispatch connection closed' },
      },
      {
        ...log,
        id: 'http-error-string',
        at: now - 2,
        level: 'error',
        message: 'API request failed',
        request_id: 'string-err-request',
        fields: { route: 'POST /api/agent', status: 500 },
      },
      {
        ...log,
        id: 'string-err-cause',
        at: now - 3,
        level: 'warn',
        request_id: 'string-err-request',
        fields: { err: 'Agent dispatch unavailable' },
      },
    ])
    const data = await getTodayErrors(now)
    expect(data.entries.find((entry) => entry.id === 'batch-error-string')?.reason).toBe(
      'Dispatch connection closed',
    )
    expect(data.entries.find((entry) => entry.id === 'http-error-string')?.reason).toBe(
      'Agent dispatch unavailable',
    )
  })

  it('requires authentication and rejects malformed time, identity, status and pagination filters', async () => {
    for (const path of ['/api/overview/today', '/api/overview/errors', '/api/tasks'])
      expect((await app.handle(new Request(`http://localhost${path}`))).status).toBe(401)
    for (const suffix of [
      'from=bad&to=1',
      `from=${from}&to=${from}`,
      'userId=a&deviceId=b',
      'status=nope',
      `from=${from}&to=${to}&cursor=bad`,
      'unassigned=2',
      `model=${'m'.repeat(129)}`,
    ])
      expect((await request(`/api/tasks?${suffix}`)).status).toBe(400)
    expect(
      (await request(`/api/tasks?from=${from}&to=${to}&userId=today-user&status=failed`)).status,
    ).toBe(200)
    expect((await request('/api/overview/today')).status).toBe(200)
    expect((await request('/api/overview/errors')).status).toBe(200)
  })
})
