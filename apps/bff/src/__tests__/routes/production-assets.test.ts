import { afterAll, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import { completionStream, scriptedAgentFetch, toolCallCompletion } from '../helpers/agentStubs'
import { silenceChatUpstream } from '../helpers/chatStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

const temp = await mkdtemp(join(tmpdir(), 'production-assets-'))
await writeFile(
  join(temp, 'operator.json'),
  JSON.stringify({ capabilities: { 'agent:chat': true, 'agent:production': true } }),
)
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.DATABASE_URL = await resetTestDatabase('production_assets')
process.env.OPERATOR_CONFIG_FILE = join(temp, 'operator.json')
const { productionRoutes } = await import('../../routes/production')
const { db, schema, close } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { createAgentConversation } = await import('../../lib/agent/conversations')
const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { assetObjectKey } = await import('../../lib/sync-assets')
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
it('previews only owned referenced images and keeps an expired reference editable', async () => {
  const owner = await account('preview-owner')
  const stranger = await account('preview-stranger')
  const storage = new InMemoryObjectStore()
  setObjectStoreForTesting(storage)
  try {
    await db.insert(schema.user_asset_objects).values({
      user_id: owner.userId,
      image_id: 'owned-image',
      bytes: 3,
      content_type: 'image/png',
      created_at: Date.now(),
    })
    await storage.write(
      assetObjectKey(owner.userId, 'owned-image'),
      new Uint8Array([1, 2, 3]),
      'image/png',
    )
    const content = {
      title: '参考图',
      setting: '',
      outline: '',
      scenes: [],
      locations: [
        {
          id: 'room',
          name: '房间',
          description: '',
          reference: { kind: 'asset', imageId: 'owned-image' },
        },
      ],
    }
    expect(
      (await request(owner, { operationId: 'initial', baseRevision: 0, content })).status,
    ).toBe(200)
    const path = '/references/preview?kind=asset&id=owned-image'
    const preview = await request(owner, undefined, path)
    expect(preview.status).toBe(200)
    expect([...new Uint8Array(await preview.arrayBuffer())]).toEqual([1, 2, 3])
    expect((await request({ ...owner, cookie: stranger.cookie }, undefined, path)).status).toBe(404)
    expect(
      (await request(owner, undefined, '/references/preview?kind=asset&id=guessed')).status,
    ).toBe(404)
    await db
      .delete(schema.user_asset_objects)
      .where(eq(schema.user_asset_objects.image_id, 'owned-image'))
    expect((await request(owner, undefined, path)).status).toBe(404)
    expect(
      (
        await request(owner, {
          operationId: 'rename',
          baseRevision: 1,
          content: { ...content, title: '保留失效参考' },
        })
      ).status,
    ).toBe(200)
  } finally {
    setObjectStoreForTesting()
  }
})
it('extracts assets as a proposal and adopts once without replacing the script', async () => {
  const owner = await account('proposal-owner')
  const content = {
    title: '雨夜',
    setting: '雨中车站',
    outline: '林晓等车',
    scenes: [{ id: 'opening', title: '开场', body: '林晓身穿黄色雨衣。' }],
  }
  await request(owner, { operationId: 'initial', baseRevision: 0, content })
  const characters = [
    {
      id: 'lin',
      name: '林晓',
      description: '摄影师',
      looks: [{ id: 'raincoat', name: '雨衣', description: '黄色雨衣' }],
    },
  ]
  const locations = [{ id: 'station', name: '车站', description: '雨夜站台' }]
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion({
            id: 'assets-one',
            name: 'proposeProductionAssets',
            args: { baseRevision: 1, characters, locations, requestQuote: '提取角色和场景' },
          }),
        () => completionStream('请检查提取建议。'),
      ],
    ),
  )
  try {
    const turn = await app.handle(
      new Request(`http://localhost/api/agent/conversations/${owner.id}/turns`, {
        method: 'POST',
        headers: { cookie: owner.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceId: 'asset-device',
          text: '提取角色和场景',
          params: { productionMode: true },
        }),
      }),
    )
    expect(turn.status).toBe(200)
    await turn.text()
    const prepared = await (await request(owner, undefined, '?assetProposals=true')).json()
    expect(prepared.document.content).toEqual(content)
    expect(prepared.assetProposals).toHaveLength(1)
    const adopt = () =>
      app.handle(
        new Request(
          `http://localhost/api/agent/conversations/${owner.id}/production/asset-proposals/${prepared.assetProposals[0].id}/adopt`,
          {
            method: 'POST',
            headers: { cookie: owner.cookie, 'content-type': 'application/json' },
            body: JSON.stringify({ operationId: 'adopt-assets', baseRevision: 1 }),
          },
        ),
      )
    const adopted = await adopt()
    expect(adopted.status).toBe(200)
    expect((await adopted.json()).document.content).toEqual({ ...content, characters, locations })
    expect((await (await adopt()).json()).document.revision).toBe(2)
    const stranger = await account('proposal-stranger')
    expect(
      (
        await app.handle(
          new Request(
            `http://localhost/api/agent/conversations/${owner.id}/production/asset-proposals/${prepared.assetProposals[0].id}/adopt`,
            {
              method: 'POST',
              headers: { cookie: stranger.cookie, 'content-type': 'application/json' },
              body: JSON.stringify({ operationId: 'foreign-adopt', baseRevision: 1 }),
            },
          ),
        )
      ).status,
    ).toBe(404)
    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () =>
            toolCallCompletion({
              id: 'assets-two',
              name: 'proposeProductionAssets',
              args: { baseRevision: 2, characters, locations: [], requestQuote: '重新提取' },
            }),
          () => completionStream('新建议。'),
        ],
      ),
    )
    const nextTurn = await app.handle(
      new Request(`http://localhost/api/agent/conversations/${owner.id}/turns`, {
        method: 'POST',
        headers: { cookie: owner.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceId: 'asset-device',
          text: '重新提取',
          params: { productionMode: true },
        }),
      }),
    )
    await nextTurn.text()
    const nextPrepared = await (await request(owner, undefined, '?assetProposals=true')).json()
    const pending = nextPrepared.assetProposals.find(
      (proposal: { status: string }) => proposal.status === 'pending',
    )
    expect(pending).toBeDefined()
    expect(
      (
        await request(owner, {
          operationId: 'concurrent-edit',
          baseRevision: 2,
          content: { ...content, characters, locations, title: '用户新标题' },
        })
      ).status,
    ).toBe(200)
    const post = (action: string, body?: unknown) =>
      app.handle(
        new Request(
          `http://localhost/api/agent/conversations/${owner.id}/production/asset-proposals/${pending.id}/${action}`,
          {
            method: 'POST',
            headers: { cookie: owner.cookie, 'content-type': 'application/json' },
            ...(body ? { body: JSON.stringify(body) } : {}),
          },
        ),
      )
    expect((await post('adopt', { operationId: 'stale-adopt', baseRevision: 2 })).status).toBe(409)
    expect((await post('discard')).status).toBe(200)
    expect((await post('adopt', { operationId: 'discarded-adopt', baseRevision: 3 })).status).toBe(
      409,
    )
    expect((await (await request(owner)).json()).document.content.title).toBe('用户新标题')
  } finally {
    setAgentFetchForTesting()
  }
})
it('rejects duplicate look identities without overwriting a saved character', async () => {
  const owner = await account('duplicate-owner')
  const content = {
    title: '初稿',
    setting: '',
    outline: '',
    scenes: [],
    characters: [
      {
        id: 'role',
        name: '主角',
        description: '',
        looks: [{ id: 'look', name: '日常', description: '' }],
      },
    ],
  }
  expect((await request(owner, { operationId: 'initial', baseRevision: 0, content })).status).toBe(
    200,
  )
  expect(
    (
      await request(owner, {
        operationId: 'duplicate',
        baseRevision: 1,
        content: {
          ...content,
          characters: [
            {
              ...content.characters[0],
              looks: [content.characters[0]!.looks[0], content.characters[0]!.looks[0]],
            },
          ],
        },
      })
    ).status,
  ).toBe(400)
  expect((await (await request(owner)).json()).document.revision).toBe(1)
})
afterAll(async () => {
  await close()
  await rm(temp, { recursive: true, force: true })
})
