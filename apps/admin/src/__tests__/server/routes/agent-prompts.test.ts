import { afterAll, describe, expect, it } from 'bun:test'
import { createDb } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'
import { applyPromptRewriteGuard, buildAspectInstruction } from '@image-playground/shared'
import type { AgentPromptsResult } from '../../../../contracts'

const url = await resetTestDatabase('admin_agent_prompts')
process.env.ADMIN_PASSWORD = 'test-pass-1234'
process.env.ADMIN_COOKIE_SECRET = 'test-cookie-secret-32-bytes-min!!'
process.env.DATABASE_URL = url
process.env.PORT = '0'
const writer = createDb(url)
const now = Date.now() - 1000
await writer.db.insert(writer.schema.agent_conversations).values([
  { id: 'conversation', device_id: 'device', title: 'test', created_at: now, updated_at: now },
  { id: 'other', device_id: 'other-device', title: 'other', created_at: now, updated_at: now },
])
await writer.db.insert(writer.schema.agent_messages).values({
  conversation_id: 'conversation',
  id: 'message',
  turn_id: 'turn',
  seq: 1,
  role: 'user',
  content: [{ type: 'text', text: '用户原话' }],
  created_at: now,
})
await writer.db.insert(writer.schema.agent_model_calls).values([
  {
    id: 'call-1',
    conversation_id: 'conversation',
    turn_id: 'turn',
    device_id: 'device',
    purpose: 'conversation',
    model: 'chat-first',
    status: 'completed',
    started_at: now - 2,
    usage: { inputTokens: 10, outputTokens: 3 },
  },
  {
    id: 'call-2',
    conversation_id: 'conversation',
    turn_id: 'turn',
    device_id: 'device',
    purpose: 'conversation',
    model: 'chat-retry',
    status: 'completed',
    started_at: now - 1,
    usage: { inputTokens: 20, outputTokens: 4 },
  },
  {
    id: 'call-3',
    conversation_id: 'conversation',
    turn_id: 'turn',
    device_id: 'device',
    purpose: 'compaction',
    model: 'summary',
    status: 'completed',
    started_at: now - 3,
    usage: { inputTokens: 900, outputTokens: 900 },
  },
])
const task = (id: string, status: 'completed' | 'failed' | 'queued' = 'completed') => ({
  id,
  provider: 'openai-compat' as const,
  model: 'image-model',
  status,
  submitted_at: now,
  agent_conversation_id: 'conversation',
  agent_turn_id: 'turn',
  request_payload: {
    prompt: `${applyPromptRewriteGuard('直出提示词')}\n\n${buildAspectInstruction('1024x1024')}`,
    size: '1024x1024',
    images: ['PRIVATE_BASE64'],
  } as never,
})
await writer.db.insert(writer.schema.tasks).values([
  task('confirmed'),
  task('direct'),
  task('failed', 'failed'),
  task('running', 'queued'),
  { ...task('manual'), agent_conversation_id: null, agent_turn_id: null },
  ...Array.from({ length: 52 }, (_, i) => ({
    ...task(`page-${String(i).padStart(2, '0')}`),
    agent_conversation_id: 'other',
    agent_turn_id: 'wake',
  })),
])
const draft = (id: string) => ({
  id,
  conversation_id: 'conversation',
  turn_id: 'turn',
  tool_call_id: id,
  tool_name: 'generate_image',
  media: 'image' as const,
  provider: 'openai-compat' as const,
  model: 'image-model',
  prompt: '原稿',
  drafted_prompt: '原稿',
  request: {} as never,
  submission: {} as never,
  created_at: now,
})
await writer.db
  .insert(writer.schema.agent_generation_drafts)
  .values([
    draft('awaiting'),
    { ...draft('edited'), prompt: '改过的提示词 100%', task_id: 'confirmed', confirmed_at: now },
    { ...draft('legacy'), drafted_prompt: null },
  ])
await writer.db.insert(writer.schema.users).values({
  id: 'owner',
  username: 'prompt-owner',
  password_hash: 'unused',
  created_at: now,
  updated_at: now,
})
await writer.db
  .insert(writer.schema.agent_conversations)
  .values({ id: 'owned', user_id: 'owner', title: 'owned', created_at: now, updated_at: now })
await writer.db.insert(writer.schema.tasks).values({
  ...task('cancelled'),
  status: 'cancelled',
  agent_conversation_id: 'owned',
  agent_turn_id: 'wake',
})
const { app } = await import('../../../../server/app')
afterAll(async () => {
  await writer.close()
})
const login = await app.handle(
  new Request('http://localhost/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.0.0.121' },
    body: JSON.stringify({ password: 'test-pass-1234' }),
  }),
)
const cookie = login.headers.get('set-cookie')!.split(';')[0]!
const base = `from=${now - 10000}&to=${now + 500}`
async function get(query = '') {
  return app.handle(
    new Request(`http://localhost/api/agent-prompts?${base}&${query}`, { headers: { cookie } }),
  )
}
async function result(query = ''): Promise<AgentPromptsResult> {
  const response = await get(query)
  expect(response.status).toBe(200)
  return response.json()
}

describe('GET /api/agent-prompts', () => {
  it('requires admin authentication', async () => {
    expect((await app.handle(new Request('http://localhost/api/agent-prompts'))).status).toBe(401)
  })
  it('unions drafts and direct tasks without double counting; retains originals and aggregates turn usage', async () => {
    const body = await result('deviceId=device')
    expect(body.items).toHaveLength(6)
    expect(body.summary).toEqual({
      total: 6,
      knownOriginal: 5,
      edited: 1,
      awaiting: 2,
      submitted: 4,
      failed: 1,
    })
    const edited = body.items.find((row) => row.id === 'edited')!
    expect(edited).toMatchObject({
      draftedPrompt: '原稿',
      prompt: '改过的提示词 100%',
      edited: true,
      taskId: 'confirmed',
      status: 'completed',
      userText: '用户原话',
      chatModel: 'chat-first',
      inputTokens: 30,
      outputTokens: 7,
    })
    expect(body.items.find((row) => row.id === 'legacy')).toMatchObject({
      draftedPrompt: null,
      edited: null,
    })
    expect(body.items.find((row) => row.id === 'direct')).toMatchObject({
      prompt: '直出提示词',
      draftedPrompt: '直出提示词',
      edited: false,
    })
    expect(JSON.stringify(body)).not.toContain('PRIVATE_BASE64')
    expect(JSON.stringify(body)).not.toContain('request_payload')
  })
  it('supports combined filters and literal keyword characters', async () => {
    expect(
      (await result('status=completed&edited=true&deviceId=device&q=100%25')).items.map(
        (x) => x.id,
      ),
    ).toEqual(['edited'])
    expect((await result('edited=unknown')).items.map((x) => x.id)).toEqual(['legacy'])
    expect((await result('status=running')).items.map((x) => x.id)).toEqual(['running'])
    expect((await result('status=failed&deviceId=device')).items.map((x) => x.id)).toEqual([
      'failed',
    ])
    expect((await result('q=nonexistent')).summary?.total).toBe(0)
  })
  it('pages equal timestamps across both sources without duplicates or missing rows', async () => {
    const first = await result()
    expect(first.items).toHaveLength(50)
    expect(first.nextCursor).not.toBeNull()
    const second = await result(`cursor=${first.nextCursor}`)
    expect(second.summary).toBeNull()
    expect(second.nextCursor).toBeNull()
    const ids = [...first.items, ...second.items].map((x) => `${x.kind}:${x.id}`)
    expect(ids).toHaveLength(59)
    expect(new Set(ids).size).toBe(59)
    expect(second.items[0]).toMatchObject({ userText: null, chatModel: null, inputTokens: 0 })
  })
  it('resolves registered owners and treats cancelled submissions as terminal', async () => {
    const body = await result('userId=owner')
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({
      userId: 'owner',
      username: 'prompt-owner',
      deviceId: null,
      status: 'failed',
      userText: null,
    })
    expect(body.summary).toMatchObject({ total: 1, submitted: 1, failed: 1 })
  })

  it('rejects invalid filters and cursors', async () => {
    const invalidDateCursor = Buffer.from(
      JSON.stringify([Number.MAX_SAFE_INTEGER, 'draft', 'id']),
    ).toString('base64url')
    expect((await get(`cursor=${invalidDateCursor}`)).status).toBe(400)
    for (const query of [
      'status=bad',
      'edited=bad',
      'userId=u&deviceId=d',
      'q=',
      'cursor=bad',
      'from=1',
      'to=bad',
    ]) {
      expect((await get(query)).status).toBe(400)
    }
    const response = await app.handle(
      new Request('http://localhost/api/agent-prompts?from=1', { headers: { cookie } }),
    )
    expect(response.status).toBe(400)
  })
})
