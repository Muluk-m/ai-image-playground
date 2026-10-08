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
      tasks: 104,
      completed: 102,
      failed: 1,
      queued: 1,
      in_progress: 0,
    })
    expect(data.actors).toHaveLength(3)
    expect(data.actors.find((actor) => actor.kind === 'user')).toMatchObject({
      id: 'today-user',
      username: 'alice',
      note: '设计师',
      tasks: 102,
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
      summary: { tasks: 0 },
    })
  })

  it('keeps the exact snapshot window and filters through stable pagination, without returning input images', async () => {
    const first = await getGenerationTasks({ from, to, userId: 'today-user' })
    expect(first.tasks).toHaveLength(100)
    expect(first.nextCursor).not.toBeNull()
    const second = await getGenerationTasks({ from, to, userId: 'today-user' }, first.nextCursor!)
    expect(second.tasks).toHaveLength(2)
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.tasks, ...second.tasks].map((task) => task.id)).size).toBe(102)
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
    expect(data.total).toBe(3)
    expect(data.entries[0]?.source).toBe('client')
    expect(data.entries.find((entry) => entry.id === 'error')).toMatchObject({
      task_id: 'today-failed',
      stack: 'redacted stack',
    })
    expect(data.entries.map((entry) => entry.id)).not.toContain('warn')
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
    ])
      expect((await request(`/api/tasks?${suffix}`)).status).toBe(400)
    expect(
      (await request(`/api/tasks?from=${from}&to=${to}&userId=today-user&status=failed`)).status,
    ).toBe(200)
    expect((await request('/api/overview/today')).status).toBe(200)
    expect((await request('/api/overview/errors')).status).toBe(200)
  })
})
