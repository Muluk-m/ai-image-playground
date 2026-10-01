import { afterAll, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { Elysia } from 'elysia'

const temp = await mkdtemp(join(tmpdir(), 'production-dependencies-'))
await writeFile(
  join(temp, 'operator.json'),
  JSON.stringify({ capabilities: { 'agent:chat': true, 'agent:production': true } }),
)
process.env.DATABASE_URL = await resetTestDatabase('production_dependencies')
process.env.OPERATOR_CONFIG_FILE = join(temp, 'operator.json')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://upstream.test'
process.env.UPSTREAM_API_KEY = 'test-key'
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
  const conversation = await createAgentConversation({ kind: 'user', userId: id }, '依赖关系')
  return { id: conversation.id, cookie: `${USER_SESSION_COOKIE}=${token}` }
}
async function request(owner: { id: string; cookie: string }, body?: unknown, suffix = '') {
  return app.handle(
    new Request(`http://localhost/api/agent/conversations/${owner.id}/production${suffix}`, {
      method: body ? (suffix ? 'POST' : 'PUT') : 'GET',
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  )
}
it('marks only dependent shots stale and explicitly acknowledges a source change as a new revision', async () => {
  const owner = await account('dependency-owner')
  const stranger = await account('dependency-stranger')
  const content = {
    title: '站台',
    setting: '',
    outline: '',
    scenes: [
      { id: 'rain', title: '雨夜', body: '下着小雨。' },
      { id: 'sun', title: '清晨', body: '阳光照耀。' },
    ],
    characters: [
      {
        id: 'traveler',
        name: '旅人',
        description: '赶路的人',
        looks: [{ id: 'coat', name: '雨衣', description: '灰色雨衣' }],
      },
    ],
    shots: [
      { id: 'rain-shot', scriptSceneId: 'rain', lookIds: ['coat'], description: '旅人走来。' },
      { id: 'sun-shot', scriptSceneId: 'sun', lookIds: [], description: '阳光中的站台。' },
    ],
  }
  expect((await request(owner, { operationId: 'first', baseRevision: 0, content })).status).toBe(
    200,
  )
  const initial = await (await request(owner)).json()
  expect(initial.shotDependencyStates).toEqual([
    { shotId: 'rain-shot', outdated: false, changed: [] },
    { shotId: 'sun-shot', outdated: false, changed: [] },
  ])
  expect(
    (
      await request(owner, {
        operationId: 'rain-change',
        baseRevision: 1,
        content: {
          ...initial.document.content,
          scenes: [{ ...content.scenes[0], body: '骤雨倾盆。' }, content.scenes[1]],
        },
      })
    ).status,
  ).toBe(200)
  const changed = await (await request(owner)).json()
  expect(changed.shotDependencyStates[0]).toMatchObject({
    shotId: 'rain-shot',
    outdated: true,
    changed: [{ kind: 'scene', id: 'rain', name: '雨夜', missing: false }],
  })
  expect(changed.shotDependencyStates[1].outdated).toBe(false)
  expect(
    (
      await request(
        { ...owner, cookie: stranger.cookie },
        { operationId: 'foreign', baseRevision: 2 },
        '/shots/rain-shot/refresh',
      )
    ).status,
  ).toBe(404)
  expect(
    (await request(owner, { operationId: 'stale', baseRevision: 1 }, '/shots/rain-shot/refresh'))
      .status,
  ).toBe(409)
  const acknowledged = await request(
    owner,
    { operationId: 'acknowledge', baseRevision: 2 },
    '/shots/rain-shot/refresh',
  )
  expect(acknowledged.status).toBe(200)
  const refreshed = await (await request(owner)).json()
  expect(refreshed.document.revision).toBe(3)
  expect(refreshed.document.content.shots[0].description).toBe('旅人走来。')
  expect(refreshed.shotDependencyStates[0].outdated).toBe(false)
  expect(
    (
      await (
        await request(
          owner,
          { operationId: 'acknowledge', baseRevision: 2 },
          '/shots/rain-shot/refresh',
        )
      ).json()
    ).document.revision,
  ).toBe(3)
  expect(
    (
      await request(owner, {
        operationId: 'delete-look',
        baseRevision: 3,
        content: { ...refreshed.document.content, characters: [] },
      })
    ).status,
  ).toBe(200)
  const missing = await (await request(owner)).json()
  expect(missing.shotDependencyStates[0].changed).toContainEqual({
    kind: 'look',
    id: 'coat',
    name: '旅人 · 雨衣',
    missing: true,
  })
  expect(missing.document.content.shots[0].lookIds).toEqual(['coat'])
})
it('tracks clip dependencies by stable shot identity across upstream edits, reorder, acknowledgement and deletion', async () => {
  const owner = await account('clip-dependency-owner')
  const content = {
    title: '雨夜',
    setting: '',
    outline: '',
    scenes: [{ id: 'scene', title: '车站', body: '她抵达车站。' }],
    shots: [
      { id: 'first', scriptSceneId: 'scene', description: '远景', lookIds: [] },
      { id: 'second', description: '车窗', lookIds: [] },
    ],
    clips: [
      {
        id: 'clip',
        name: '开场',
        shotIds: ['first'],
        prompt: '车站中的旅人',
        model: 'grok-imagine-video',
        video: { duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p' },
        references: [],
        sourceRevision: 0,
      },
    ],
  }
  expect((await request(owner, { operationId: 'first', baseRevision: 0, content })).status).toBe(
    200,
  )
  const initial = await (await request(owner)).json()
  expect(initial.dependencyStates).toEqual([{ clipId: 'clip', outdated: false, changed: [] }])
  expect(
    (
      await request(owner, {
        operationId: 'unrelated',
        baseRevision: 1,
        content: {
          ...initial.document.content,
          shots: [{ ...content.shots[1], description: '移动的车窗' }, content.shots[0]],
        },
      })
    ).status,
  ).toBe(200)
  expect((await (await request(owner)).json()).dependencyStates[0].outdated).toBe(false)
  const current = (await (await request(owner)).json()).document.content
  expect(
    (
      await request(owner, {
        operationId: 'upstream',
        baseRevision: 2,
        content: { ...current, scenes: [{ ...content.scenes[0], body: '她离开车站。' }] },
      })
    ).status,
  ).toBe(200)
  const changed = await (await request(owner)).json()
  expect(changed.dependencyStates[0].changed).toContainEqual({
    kind: 'scene',
    id: 'scene',
    name: '车站',
    missing: false,
  })
  const forged = {
    ...changed.document.content,
    clips: changed.document.content.clips.map((clip: Record<string, unknown>) => ({
      ...clip,
      dependencies: [],
      sourceRevision: 999,
    })),
  }
  expect(
    (await request(owner, { operationId: 'forge-dependencies', baseRevision: 3, content: forged }))
      .status,
  ).toBe(200)
  expect((await (await request(owner)).json()).dependencyStates[0].outdated).toBe(true)
  expect(
    (await request(owner, { operationId: 'refresh-clip', baseRevision: 4 }, '/clips/clip/refresh'))
      .status,
  ).toBe(200)
  const refreshed = await (await request(owner)).json()
  expect(refreshed.dependencyStates[0].outdated).toBe(false)
  expect(refreshed.document.content.clips[0].prompt).toBe(content.clips[0].prompt)
  expect(
    (
      await request(owner, {
        operationId: 'delete-shot',
        baseRevision: 5,
        content: {
          ...refreshed.document.content,
          shots: refreshed.document.content.shots.filter(
            (shot: { id: string }) => shot.id !== 'first',
          ),
        },
      })
    ).status,
  ).toBe(200)
  const deleted = await (await request(owner)).json()
  expect(deleted.dependencyStates[0].changed).toContainEqual({
    kind: 'shot',
    id: 'first',
    name: '远景',
    missing: true,
  })
  expect(deleted.document.content.clips[0].shotIds).toEqual(['first'])
  expect(
    (
      await request(
        owner,
        { operationId: 'restore-source', baseRevision: 6, revision: 2 },
        '/restore',
      )
    ).status,
  ).toBe(200)
  const restored = await (await request(owner)).json()
  expect(restored.document.revision).toBe(7)
  expect(restored.dependencyStates[0].outdated).toBe(false)
  expect(restored.document.content.clips[0].shotIds).toEqual(['first'])
  expect(await db.select({ id: schema.tasks.id }).from(schema.tasks)).toHaveLength(0)
})
afterAll(async () => {
  await close()
  await rm(temp, { recursive: true, force: true })
})
