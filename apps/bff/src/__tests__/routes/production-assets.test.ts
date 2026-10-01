import { afterAll, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { Elysia } from 'elysia'

const temp = await mkdtemp(join(tmpdir(), 'production-assets-'))
await writeFile(
  join(temp, 'operator.json'),
  JSON.stringify({ capabilities: { 'agent:chat': true, 'agent:production': true } }),
)
process.env.DATABASE_URL = await resetTestDatabase('production_assets')
process.env.OPERATOR_CONFIG_FILE = join(temp, 'operator.json')
const { productionRoutes } = await import('../../routes/production')
const { db, schema, close } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { createAgentConversation } = await import('../../lib/agent/conversations')
const app = new Elysia().use(productionRoutes)
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
it('persists one character with distinct looks and a location without changing their identities on rename', async () => {
  const owner = await account('asset-owner')
  const content = {
    title: '雨夜',
    setting: '',
    outline: '',
    scenes: [],
    characters: [
      {
        id: 'lin',
        name: '林',
        description: '年轻摄影师',
        looks: [
          { id: 'raincoat', name: '雨衣', description: '黄色雨衣' },
          { id: 'daily', name: '日常', description: '白色衬衫' },
        ],
      },
    ],
    locations: [{ id: 'station', name: '车站', description: '雨中的站台' }],
  }
  const saved = await request(owner, { operationId: 'first', baseRevision: 0, content })
  expect(saved.status).toBe(200)
  expect((await saved.json()).document.content.characters).toEqual(content.characters)
  const renamed = {
    ...content,
    characters: [
      {
        ...content.characters[0],
        name: '林晓',
        looks: [content.characters[0]!.looks[1], content.characters[0]!.looks[0]],
      },
    ],
  }
  expect(
    (await request(owner, { operationId: 'rename', baseRevision: 1, content: renamed })).status,
  ).toBe(200)
  const read = await (await request(owner)).json()
  expect(read.document.content.characters[0].id).toBe('lin')
  expect(read.document.content.characters[0].looks.map((look: { id: string }) => look.id)).toEqual([
    'daily',
    'raincoat',
  ])
  expect(read.document.content.locations[0].id).toBe('station')
})
it('rejects foreign or missing reference images without saving them', async () => {
  const owner = await account('reference-owner')
  const stranger = await account('reference-stranger')
  await db.insert(schema.user_asset_objects).values({
    user_id: stranger.userId,
    image_id: 'foreign-image',
    bytes: 12,
    content_type: 'image/png',
    created_at: Date.now(),
  })
  const content = {
    title: '参考',
    setting: '',
    outline: '',
    scenes: [],
    locations: [
      {
        id: 'room',
        name: '房间',
        description: '夜晚',
        reference: { kind: 'asset', imageId: 'foreign-image' },
      },
    ],
  }
  expect((await request(owner, { operationId: 'foreign', baseRevision: 0, content })).status).toBe(
    400,
  )
  expect((await (await request(owner)).json()).document).toBeNull()
  const missing = {
    ...content,
    locations: [
      { ...content.locations[0], reference: { kind: 'media', mediaId: 'missing-media' } },
    ],
  }
  expect(
    (await request(owner, { operationId: 'missing', baseRevision: 0, content: missing })).status,
  ).toBe(400)
  expect(
    (
      await request(
        { ...owner, cookie: stranger.cookie },
        { operationId: 'foreign-conversation', baseRevision: 0, content },
      )
    ).status,
  ).toBe(404)
})
afterAll(async () => {
  await close()
  await rm(temp, { recursive: true, force: true })
})
