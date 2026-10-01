import { afterAll, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { TEST_IMAGE_CHANNEL } from '../helpers/agentStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'

const temp = await mkdtemp(join(tmpdir(), 'production-generation-'))
await writeFile(
  join(temp, 'operator.json'),
  JSON.stringify({
    capabilities: {
      'agent:chat': true,
      'agent:production': true,
      'billing:credits': true,
      'accounts:login': true,
      'accounts:sync': true,
    },
  }),
)
process.env.DATABASE_URL = await resetTestDatabase('production_generations')
process.env.OPERATOR_CONFIG_FILE = join(temp, 'operator.json')
process.env.PORT = '0'
const billing = installRecordingTaskHooks()
const { productionRoutes } = await import('../../routes/production')
const { syncRoutes } = await import('../../routes/sync')
const { workerSettles } = await import('../helpers/taskWorker')
const { agentRoutes } = await import('../../routes/agent')
const { db, schema, close } = await import('../../db/client')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { createAgentConversation } = await import('../../lib/agent/conversations')
const storage = new InMemoryObjectStore()
setObjectStoreForTesting(storage)
_setChannelsForTesting([
  {
    ...TEST_IMAGE_CHANNEL,
    models: TEST_IMAGE_CHANNEL.models.map((model) => ({
      ...model,
      capabilities: ['generate', 'edit', 'quality', 'size'],
    })),
  },
])
const app = new Elysia().use(productionRoutes).use(agentRoutes).use(syncRoutes)
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
  const conversation = await createAgentConversation({ kind: 'user', userId: id }, '角色图')
  return { cookie: `${USER_SESSION_COOKIE}=${token}`, id: conversation.id, userId: id }
}
async function request(
  owner: { id: string; cookie: string },
  method: string,
  path = '',
  body?: unknown,
) {
  return app.handle(
    new Request(`http://localhost/api/agent/conversations/${owner.id}/production${path}`, {
      method,
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  )
}
it('creates one confirmed-generation draft bound to a saved look without reserving credits', async () => {
  const owner = await account('generation-owner')
  const content = {
    title: '雨夜',
    setting: '',
    outline: '',
    scenes: [],
    characters: [
      {
        id: 'lin',
        name: '林晓',
        description: '',
        looks: [{ id: 'raincoat', name: '雨衣', description: '黄色雨衣' }],
      },
    ],
  }
  const first = await request(owner, 'PUT', '', {
    operationId: 'initial',
    baseRevision: 0,
    content,
  })
  expect(first.status).toBe(200)
  const input = {
    operationId: 'draft-one',
    baseRevision: 1,
    target: 'look',
    targetId: 'raincoat',
    prompt: '黄色雨衣角色正面图',
    model: TEST_IMAGE_CHANNEL.models[0]!.id,
    references: [],
  }
  const draft = await request(owner, 'POST', '/generations', input)
  expect(draft.status).toBe(200)
  const prepared = await draft.json()
  expect(prepared.generation.production).toMatchObject({
    target: 'look',
    targetId: 'raincoat',
    revision: 1,
    snapshot: { name: '雨衣', description: '黄色雨衣' },
  })
  expect(prepared.generation.status).toBe('awaiting_confirmation')
  expect(prepared.generation.messageId).toBeString()
  expect(billing.reservations).toHaveLength(0)
  const replay = await (await request(owner, 'POST', '/generations', input)).json()
  expect(replay.generation.draftId).toBe(prepared.generation.draftId)
  expect((await (await request(owner, 'GET', '/generations')).json()).generations).toHaveLength(1)
})
it('edits a reference draft, confirms exactly once and explicitly adopts its owned result', async () => {
  billing.reset()
  const owner = await account('generation-flow-owner')
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII='
  const upload = await app.handle(
    new Request('http://localhost/api/sync/assets/production-ref', {
      method: 'PUT',
      headers: { cookie: owner.cookie, 'content-type': 'image/png' },
      body: Buffer.from(png, 'base64'),
    }),
  )
  expect(upload.status).toBe(200)
  const reference = { kind: 'asset', imageId: 'production-ref' }
  const content = {
    title: '场景',
    setting: '',
    outline: '',
    scenes: [],
    locations: [{ id: 'room', name: '房间', description: '晚霞照进来', reference }],
  }
  await request(owner, 'PUT', '', { operationId: 'initial', baseRevision: 0, content })
  const { generation } = await (
    await request(owner, 'POST', '/generations', {
      operationId: 'draft',
      baseRevision: 1,
      target: 'location',
      targetId: 'room',
      prompt: '室内场景图',
      model: TEST_IMAGE_CHANNEL.models[0]!.id,
      references: [{ reference }],
    })
  ).json()
  const edited = await request(owner, 'PATCH', `/generations/${generation.draftId}`, {
    draftRevision: 1,
    prompt: '傍晚室内场景图',
    model: TEST_IMAGE_CHANNEL.models[0]!.id,
    params: { quality: 'high' },
    references: [{ reference }],
  })
  expect(edited.status).toBe(200)
  expect((await edited.json()).generation.draftRevision).toBe(2)
  expect(billing.reservations).toHaveLength(0)
  const confirm = () =>
    app.handle(
      new Request(`http://localhost/api/agent/conversations/${owner.id}/confirmations`, {
        method: 'POST',
        headers: { cookie: owner.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceId: 'production-device',
          messageId: generation.messageId,
          prompt: '傍晚室内场景图',
          draftRevision: 2,
        }),
      }),
    )
  const confirmed = await confirm()
  expect(confirmed.status).toBe(200)
  expect((await confirm()).status).toBe(200)
  expect(billing.reservations).toHaveLength(1)
  const submitted = (await (await request(owner, 'GET', '/generations')).json()).generations[0]
  expect(submitted.production.targetId).toBe('room')
  expect(submitted.taskId).toBeString()
  await workerSettles(submitted.taskId, {
    status: 'completed',
    resultPayload: { data: [{ b64_json: png, mime: 'image/png' }] },
  })
  const completed = (await (await request(owner, 'GET', '/generations')).json()).generations[0]
  expect(completed.artifacts).toHaveLength(1)
  expect(
    (await (await request(owner, 'GET')).json()).document.content.locations[0].reference,
  ).toEqual(reference)
  const adopt = () =>
    request(owner, 'POST', `/generations/${generation.draftId}/adopt`, {
      operationId: 'adopt-candidate',
      baseRevision: 1,
      artifactId: completed.artifacts[0].artifactId,
    })
  const adopted = await adopt()
  expect(adopted.status).toBe(200)
  expect((await adopted.json()).document.content.locations[0].reference).toEqual({
    kind: 'artifact',
    artifactId: completed.artifacts[0].artifactId,
  })
  expect((await (await adopt()).json()).document.revision).toBe(2)
  expect((await (await request(owner, 'GET', '/generations')).json()).generations).toHaveLength(1)
})
it('rejects stale confirmation and unsupported edited parameters before reserving credits', async () => {
  billing.reset()
  const owner = await account('generation-stale-owner')
  const content = {
    title: '场景',
    setting: '',
    outline: '',
    scenes: [],
    locations: [{ id: 'room', name: '房间', description: '晚霞' }],
  }
  await request(owner, 'PUT', '', { operationId: 'initial', baseRevision: 0, content })
  const input = {
    operationId: 'draft',
    baseRevision: 1,
    target: 'location',
    targetId: 'room',
    prompt: '原提示词',
    model: TEST_IMAGE_CHANNEL.models[0]!.id,
    references: [],
  }
  const { generation } = await (await request(owner, 'POST', '/generations', input)).json()
  expect(
    (
      await request(owner, 'PATCH', `/generations/${generation.draftId}`, {
        draftRevision: 1,
        prompt: '新提示词',
        model: input.model,
        references: [],
      })
    ).status,
  ).toBe(200)
  expect(
    (
      await request(owner, 'PATCH', `/generations/${generation.draftId}`, {
        draftRevision: 1,
        prompt: '旧页覆盖',
        model: input.model,
        references: [],
      })
    ).status,
  ).toBe(409)
  expect(
    (
      await request(owner, 'PATCH', `/generations/${generation.draftId}`, {
        draftRevision: 2,
        prompt: '不支持参数',
        model: input.model,
        params: { quality: 'magic' },
        references: [],
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await request(owner, 'PATCH', `/generations/${generation.draftId}`, {
        draftRevision: 2,
        prompt: '下线模型',
        model: 'missing-model',
        references: [],
      })
    ).status,
  ).toBe(400)
  const stale = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${owner.id}/confirmations`, {
      method: 'POST',
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'production-device',
        messageId: generation.messageId,
        prompt: '原提示词',
        draftRevision: 1,
      }),
    }),
  )
  expect(stale.status).toBe(409)
  expect(billing.reservations).toHaveLength(0)
})
it('refuses a draft whose original reference disappeared before confirmation', async () => {
  billing.reset()
  const owner = await account('generation-expired-owner')
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBz8AAAAASUVORK5CYII='
  expect(
    (
      await app.handle(
        new Request('http://localhost/api/sync/assets/expiring-ref', {
          method: 'PUT',
          headers: { cookie: owner.cookie, 'content-type': 'image/png' },
          body: Buffer.from(png, 'base64'),
        }),
      )
    ).status,
  ).toBe(200)
  const reference = { kind: 'asset', imageId: 'expiring-ref' }
  await request(owner, 'PUT', '', {
    operationId: 'initial',
    baseRevision: 0,
    content: {
      title: '场景',
      setting: '',
      outline: '',
      scenes: [],
      locations: [{ id: 'room', name: '房间', description: '', reference }],
    },
  })
  const { generation } = await (
    await request(owner, 'POST', '/generations', {
      operationId: 'draft',
      baseRevision: 1,
      target: 'location',
      targetId: 'room',
      prompt: '参考房间',
      model: TEST_IMAGE_CHANNEL.models[0]!.id,
      references: [{ reference }],
    })
  ).json()
  await db
    .delete(schema.user_asset_objects)
    .where(eq(schema.user_asset_objects.image_id, 'expiring-ref'))
  const confirmed = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${owner.id}/confirmations`, {
      method: 'POST',
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'production-device',
        messageId: generation.messageId,
        prompt: '参考房间',
        draftRevision: 1,
      }),
    }),
  )
  expect(confirmed.status).toBe(409)
  expect(billing.reservations).toHaveLength(0)
})
afterAll(async () => {
  setObjectStoreForTesting()
  await close()
  await rm(temp, { recursive: true, force: true })
})
