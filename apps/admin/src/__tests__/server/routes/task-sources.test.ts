import { afterAll, describe, expect, it } from 'bun:test'
import { createDb } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentPromptsResult, GenerationTasksResult, TaskDetail } from '../../../../contracts'

process.env.DATABASE_URL = await resetTestDatabase('admin_task_sources')
process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.PORT = '0'
const writer = createDb(process.env.DATABASE_URL)
const now = Date.now() - 1000
const draftedAt = now - 40 * 86400_000
await writer.db.insert(writer.schema.agent_conversations).values({
  id: 'conversation',
  device_id: 'device',
  title: 'test',
  created_at: draftedAt,
  updated_at: now,
})
const base = {
  provider: 'openai-compat' as const,
  model: 'image',
  status: 'completed' as const,
  submitted_at: now,
  request_payload: { prompt: '杯子', device_id: 'device' } as never,
}
await writer.db.insert(writer.schema.tasks).values([
  ...Array.from({ length: 101 }, (_, i) => ({
    ...base,
    id: `chat-${String(i).padStart(3, '0')}`,
    agent_conversation_id: 'conversation',
    agent_turn_id: 'turn',
  })),
  {
    ...base,
    id: 'delayed',
    status: 'failed',
    agent_conversation_id: 'conversation',
    agent_turn_id: 'turn',
  },
  { ...base, id: 'manual-1' },
  { ...base, id: 'manual-2', status: 'queued', model: 'other' },
  { ...base, id: 'hidden-chat-call', kind: 'chat', agent_conversation_id: 'conversation' },
])
await writer.db.insert(writer.schema.agent_generation_drafts).values({
  id: 'old-draft',
  conversation_id: 'conversation',
  turn_id: 'turn',
  tool_call_id: 'call',
  tool_name: 'generateImage',
  media: 'image',
  provider: 'openai-compat',
  model: 'image',
  prompt: '杯子',
  drafted_prompt: '杯子',
  request: {} as never,
  submission: {} as never,
  task_id: 'delayed',
  created_at: draftedAt,
})
const { app } = await import('../../../../server/app')
const login = await app.handle(
  new Request('http://localhost/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.122' },
    body: JSON.stringify({ password: 'test-pass-1234' }),
  }),
)
const cookie = login.headers.get('set-cookie')!.split(';')[0]!
const range = `from=${now - 10000}&to=${now + 500}`
const get = (path: string) =>
  app.handle(new Request(`http://localhost${path}`, { headers: { cookie } }))
const tasks = async (query = ''): Promise<GenerationTasksResult> => {
  const r = await get(`/api/tasks?${range}&${query}`)
  expect(r.status).toBe(200)
  return r.json()
}
afterAll(() => writer.close())
describe('task source attribution', () => {
  it('filters sources before keyset pagination, composes filters, and excludes model-call rows', async () => {
    const first = await tasks('source=chat')
    const second = await tasks(`source=chat&cursor=${first.nextCursor}`)
    expect(first.tasks).toHaveLength(100)
    expect(second.tasks).toHaveLength(2)
    const all = [...first.tasks, ...second.tasks]
    expect(new Set(all.map((x) => x.id)).size).toBe(102)
    expect(all.every((x) => x.source === 'chat')).toBe(true)
    expect(all.some((x) => x.id === 'hidden-chat-call')).toBe(false)
    const manual = await tasks('source=manual')
    expect(manual.tasks.map((x) => x.id)).toEqual(['manual-2', 'manual-1'])
    expect(manual.tasks.every((x) => x.source === 'manual')).toBe(true)
    expect((await tasks('source=chat&status=failed&model=image')).tasks.map((x) => x.id)).toEqual([
      'delayed',
    ])
    expect((await tasks('source=manual&status=queued')).tasks.map((x) => x.id)).toEqual([
      'manual-2',
    ])
  })
  it('keeps the original draft timestamp for delayed confirmation and supports an exact prompt link', async () => {
    const detail: TaskDetail = await (await get('/api/tasks/delayed')).json()
    expect(detail.source).toBe('chat')
    expect(detail.prompt_created_at).toBe(draftedAt)
    const direct: TaskDetail = await (await get('/api/tasks/chat-000')).json()
    expect(direct.prompt_created_at).toBe(now)
    const manual: TaskDetail = await (await get('/api/tasks/manual-1')).json()
    expect(manual.source).toBe('manual')
    expect(manual.prompt_created_at).toBeUndefined()
    const r = await get(
      `/api/agent-prompts?from=${draftedAt - 1000}&to=${draftedAt + 1000}&taskId=delayed`,
    )
    expect(r.status).toBe(200)
    const prompts: AgentPromptsResult = await r.json()
    expect(prompts.items.map((x) => x.id)).toEqual(['old-draft'])
    expect(prompts.summary?.total).toBe(1)
    expect((await (await get(`/api/agent-prompts?${range}&taskId=missing`)).json()).items).toEqual(
      [],
    )
  })
  it('validates source/task filters and requires authentication', async () => {
    expect(
      (await app.handle(new Request(`http://localhost/api/tasks?${range}&source=chat`))).status,
    ).toBe(401)
    for (const source of ['unknown', '', 'CHAT'])
      expect((await get(`/api/tasks?${range}&source=${source}`)).status).toBe(400)
    for (const taskId of ['', 'x'.repeat(201)])
      expect((await get(`/api/agent-prompts?${range}&taskId=${taskId}`)).status).toBe(400)
  })
})
