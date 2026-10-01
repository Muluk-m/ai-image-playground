import { afterAll, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { Elysia } from 'elysia'
import { silenceChatUpstream } from '../helpers/chatStubs'

const temp = await mkdtemp(join(tmpdir(), 'production-clips-'))
await writeFile(
  join(temp, 'operator.json'),
  JSON.stringify({ capabilities: { 'agent:chat': true, 'agent:production': true } }),
)
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.DATABASE_URL = await resetTestDatabase('production_clips')
process.env.OPERATOR_CONFIG_FILE = join(temp, 'operator.json')
const { productionRoutes } = await import('../../routes/production')
const { db, schema, close } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { createAgentConversation } = await import('../../lib/agent/conversations')
const { agentRoutes } = await import('../../routes/agent')
await silenceChatUpstream()
const app = new Elysia().use(productionRoutes).use(agentRoutes)
async function account(id: string) {
  await db.insert(schema.users).values({
    id,
    username: id,
    password_hash: 'fixture',
    status: 'active',
    created_at: Date.now(),
    updated_at: Date.now(),
  })
  const token = await db.transaction((tx) => createUserSession(id, tx))
  const conversation = await createAgentConversation({ kind: 'user', userId: id }, '角色设计')
  return { cookie: `${USER_SESSION_COOKIE}=${token}`, id: conversation.id, userId: id }
}
async function request(owner: { id: string; cookie: string }, body?: unknown, path = '') {
  return app.handle(
    new Request(`http://localhost/api/agent/conversations/${owner.id}/production${path}`, {
      method: body ? 'PUT' : 'GET',
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  )
}
it('persists a multi-shot clip plan and preserves its frozen order after the board is reordered', async () => {
  const owner = await account('clip-owner')
  const shots = [
    { id: 's1', description: '雨滴落在车窗上', lookIds: [] },
    { id: 's2', description: '林遥望向远处', lookIds: [] },
  ]
  const clip = {
    id: 'clip-1',
    name: '雨夜开场',
    shotIds: ['s1', 's2'],
    prompt: '雨滴滑落车窗，镜头移向望向远处的林遥。',
    model: 'grok-imagine-video',
    video: { duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p' },
    references: [],
    sourceRevision: 0,
  }
  const content = { title: '雨夜', setting: '', outline: '', scenes: [], shots, clips: [clip] }
  const saved = await request(owner, { operationId: 'create', baseRevision: 0, content })
  expect(saved.status).toBe(200)
  expect((await saved.json()).document.content.clips[0]).toMatchObject(clip)
  const reordered = await request(owner, {
    operationId: 'reorder',
    baseRevision: 1,
    content: { ...content, shots: [shots[1], shots[0]] },
  })
  expect(reordered.status).toBe(200)
  const read = await (await request(owner)).json()
  expect(read.document.content.clips[0].shotIds).toEqual(['s1', 's2'])
  expect(read.document.content.clips[0].video.duration_seconds).toBe(5)
})
it('rejects unsupported video settings, foreign shot IDs and forged adoption without creating tasks', async () => {
  const owner = await account('clip-invalid')
  const clip = {
    id: 'clip',
    name: '开场',
    shotIds: ['shot'],
    prompt: '缓慢推进',
    model: 'grok-imagine-video',
    video: { duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p' },
    references: [],
    sourceRevision: 0,
  }
  const content = {
    title: '车站',
    setting: '',
    outline: '',
    scenes: [],
    shots: [{ id: 'shot', description: '车站远景', lookIds: [] }],
    clips: [clip],
  }
  for (const bad of [
    { ...clip, video: { ...clip.video, duration_seconds: 6 } },
    { ...clip, shotIds: ['foreign'] },
    {
      ...clip,
      adopted: { draftId: 'foreign-draft', artifactId: 'foreign-artifact', adoptedAt: 1 },
    },
  ]) {
    const result = await request(owner, {
      operationId: crypto.randomUUID(),
      baseRevision: 0,
      content: { ...content, clips: [bad] },
    })
    expect(result.status).toBe(400)
  }
  expect((await (await request(owner)).json()).document).toBeNull()
  const { eq } = await import('drizzle-orm')
  expect(
    await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(eq(schema.tasks.agent_conversation_id, owner.id)),
  ).toHaveLength(0)
})
it('retains a broken existing shot reference after deletion but refuses new broken references', async () => {
  const owner = await account('clip-deleted-shot')
  const clip = {
    id: 'clip',
    name: '开场',
    shotIds: ['shot'],
    prompt: '缓慢推进',
    model: 'grok-imagine-video',
    video: { duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p' },
    references: [],
    sourceRevision: 0,
  }
  const content = {
    title: '车站',
    setting: '',
    outline: '',
    scenes: [],
    shots: [{ id: 'shot', description: '车站远景', lookIds: [] }],
    clips: [clip],
  }
  expect((await request(owner, { operationId: 'first', baseRevision: 0, content })).status).toBe(
    200,
  )
  expect(
    (
      await request(owner, {
        operationId: 'delete-shot',
        baseRevision: 1,
        content: { ...content, shots: [] },
      })
    ).status,
  ).toBe(200)
  expect((await (await request(owner)).json()).document.content.clips[0].shotIds).toEqual(['shot'])
  expect(
    (
      await request(owner, {
        operationId: 'unknown',
        baseRevision: 2,
        content: { ...content, shots: [], clips: [{ ...clip, shotIds: ['unknown'] }] },
      })
    ).status,
  ).toBe(400)
})
afterAll(async () => {
  await close()
  await rm(temp, { recursive: true, force: true })
})
