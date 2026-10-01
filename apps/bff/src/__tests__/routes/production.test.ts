import { afterAll, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { Elysia } from 'elysia'
import {
  type AgentCall,
  completionStream,
  controlledCompletion,
  scriptedAgentFetch,
  toolCallCompletion,
} from '../helpers/agentStubs'
import { silenceChatUpstream } from '../helpers/chatStubs'
import { waitFor } from '../helpers/upstreamStubs'

const temp = await mkdtemp(join(tmpdir(), 'production-test-'))
await writeFile(
  join(temp, 'operator.json'),
  JSON.stringify({ capabilities: { 'agent:chat': true, 'agent:production': true } }),
)
process.env.DATABASE_URL = await resetTestDatabase('production_document')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = join(temp, 'operator.json')
const { productionRoutes } = await import('../../routes/production')
const { db, schema, close } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { createAgentConversation } = await import('../../lib/agent/conversations')
const { config } = await import('../../config')
const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
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
  const conversation = await createAgentConversation({ kind: 'user', userId: id }, '雨夜')
  return { cookie: `${USER_SESSION_COOKIE}=${token}`, id: conversation.id }
}
async function request(id: string, cookie: string, body?: unknown) {
  return app.handle(
    new Request(`http://localhost/api/agent/conversations/${id}/production`, {
      method: body ? 'PUT' : 'GET',
      headers: { cookie, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  )
}
it('creates a session-owned script, restores it and rejects foreign access and stale revisions', async () => {
  const a = await account('production-owner')
  const b = await account('production-stranger')
  const content = {
    title: '雨夜',
    setting: '上海，雨夜',
    outline: '一次偶遇',
    scenes: [{ id: 'scene-one', title: '站台', body: '她撑着伞走来。' }],
  }
  const mutation = { operationId: 'create-first-script', baseRevision: 0, content }
  const first = await request(a.id, a.cookie, mutation)
  expect(first.status).toBe(200)
  const saved = await first.json()
  expect(saved.document.content).toEqual(content)
  expect(saved.document.revision).toBe(1)
  expect((await (await request(a.id, a.cookie)).json()).document.id).toBe(saved.document.id)
  expect((await (await request(a.id, a.cookie, mutation)).json()).document.revision).toBe(1)
  expect((await request(a.id, b.cookie)).status).toBe(404)
  expect((await request(a.id, a.cookie, { ...mutation, operationId: 'stale-write' })).status).toBe(
    409,
  )
})
it('denies disabled production reads and writes without changing the saved text', async () => {
  const owner = await account('production-disabled')
  const content = { title: '剧本', setting: '保留', outline: '', scenes: [] }
  await request(owner.id, owner.cookie, { operationId: 'initial', baseRevision: 0, content })
  const original = config.operator
  config.operator = {
    ...original,
    capabilities: { ...original.capabilities, 'agent:production': false },
  }
  try {
    expect((await request(owner.id, owner.cookie)).status).toBe(404)
    expect(
      (
        await request(owner.id, owner.cookie, {
          operationId: 'denied',
          baseRevision: 1,
          content: { ...content, setting: '覆盖' },
        })
      ).status,
    ).toBe(404)
  } finally {
    config.operator = original
  }
  expect((await (await request(owner.id, owner.cookie)).json()).document.content.setting).toBe(
    '保留',
  )
})
it('restores an earlier script as a new revision without losing intervening history', async () => {
  const owner = await account('production-editor')
  const first = { title: '初稿', setting: '雨夜', outline: '相遇', scenes: [] }
  await request(owner.id, owner.cookie, { operationId: 'first', baseRevision: 0, content: first })
  await request(owner.id, owner.cookie, {
    operationId: 'edit',
    baseRevision: 1,
    content: { ...first, title: '二稿' },
  })
  const restore = () =>
    app.handle(
      new Request(`http://localhost/api/agent/conversations/${owner.id}/production/restore`, {
        method: 'POST',
        headers: { cookie: owner.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ operationId: 'restore-first', baseRevision: 2, revision: 1 }),
      }),
    )
  const result = await restore()
  expect(result.status).toBe(200)
  const saved = await result.json()
  expect(saved.document.revision).toBe(3)
  expect(saved.document.content.title).toBe('初稿')
  expect(saved.history.map((r: { revision: number }) => r.revision)).toEqual([1, 2, 3])
  expect(saved.history[2].source).toBe('restore')
  expect((await (await restore()).json()).document.revision).toBe(3)
})
it('executes the real Agent tool through SSE and reads the saved script through HTTP', async () => {
  const owner = await account('production-agent')
  const content = {
    title: '最后一班车',
    setting: '雨夜',
    outline: '陌生人相遇',
    scenes: [{ id: 'platform', title: '站台', body: '列车驶进雨幕。' }],
  }
  const calls: AgentCall[] = []
  setAgentFetchForTesting(
    scriptedAgentFetch(calls, [
      () => toolCallCompletion({ id: 'script-call', name: 'writeProduction', args: { content } }),
      () => completionStream('剧本已保存，请查看右侧面板。'),
    ]),
  )
  const response = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${owner.id}/turns`, {
      method: 'POST',
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'production-device',
        text: '写一个雨夜站台的短片剧本并保存',
        params: { productionMode: true, autoSubmit: true },
      }),
    }),
  )
  expect(response.status).toBe(200)
  const stream = await response.text()
  expect(stream).toContain('writeProduction')
  expect(JSON.stringify(calls[0]?.messages)).toContain('当前是视频制作对话')
  expect(JSON.stringify(calls[0]?.messages)).not.toContain('拟好提示词就当场提交')
  expect((await (await request(owner.id, owner.cookie)).json()).document.content).toEqual(content)
  setAgentFetchForTesting()
})
it('freezes a quoted target, proposes an Agent edit and adopts it once without overwriting the original early', async () => {
  const owner = await account('production-quote')
  const content = {
    title: '雨夜',
    setting: '',
    outline: '',
    scenes: [{ id: 'platform', title: '站台', body: '她撑着伞走来。' }],
  }
  const initial = await (
    await request(owner.id, owner.cookie, { operationId: 'first', baseRevision: 0, content })
  ).json()
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion({
            id: 'proposal-one',
            name: 'proposeProductionEdit',
            args: { replacement: '红伞', requestQuote: '把伞改成红伞' },
          }),
        () => completionStream('修改建议已准备好。'),
      ],
    ),
  )
  const result = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${owner.id}/turns`, {
      method: 'POST',
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'production-device',
        text: '把伞改成红伞',
        params: {
          productionMode: true,
          production: {
            documentId: initial.document.id,
            revision: 1,
            target: 'scene',
            sceneId: 'platform',
            quote: { start: 3, end: 4, text: '伞' },
          },
        },
      }),
    }),
  )
  expect(result.status).toBe(200)
  await result.text()
  const response = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${owner.id}/production?proposals=true`, {
      headers: { cookie: owner.cookie },
    }),
  )
  const prepared = await response.json()
  expect(prepared.document.content.scenes[0].body).toBe('她撑着伞走来。')
  expect(prepared.proposals).toHaveLength(1)
  expect(prepared.proposals[0].after).toBe('她撑着红伞走来。')
  const adopt = () =>
    app.handle(
      new Request(
        `http://localhost/api/agent/conversations/${owner.id}/production/proposals/${prepared.proposals[0].id}/adopt`,
        {
          method: 'POST',
          headers: { cookie: owner.cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ operationId: 'adopt-first', baseRevision: 1 }),
        },
      ),
    )
  const adopted = await adopt()
  expect(adopted.status).toBe(200)
  expect((await adopted.json()).document.content.scenes[0].body).toBe('她撑着红伞走来。')
  expect((await (await adopt()).json()).document.revision).toBe(2)
  setAgentFetchForTesting()
})
it('keeps a queued quote snapshot and refuses its stale offsets after a direct edit', async () => {
  const owner = await account('production-queued')
  const content = { title: '剧本', setting: '雨夜', outline: '', scenes: [] }
  const original = await (
    await request(owner.id, owner.cookie, { operationId: 'initial', baseRevision: 0, content })
  ).json()
  const first = controlledCompletion()
  const calls: AgentCall[] = []
  setAgentFetchForTesting(
    scriptedAgentFetch(calls, [
      () => first.responseFor(),
      () =>
        toolCallCompletion({
          id: 'stale-call',
          name: 'proposeProductionEdit',
          args: { replacement: '雪夜', requestQuote: '把雨夜改成雪夜' },
        }),
      () => completionStream('原文已更新，请重新引用。'),
    ]),
  )
  const send = (text: string, params?: unknown) =>
    app.handle(
      new Request(`http://localhost/api/agent/conversations/${owner.id}/turns`, {
        method: 'POST',
        headers: { cookie: owner.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: 'production-device', text, params }),
      }),
    )
  const ongoing = await send('先聊聊故事')
  const drained = ongoing.text()
  await waitFor(() => calls.length === 1)
  const queued = await send('把雨夜改成雪夜', {
    productionMode: true,
    production: {
      documentId: original.document.id,
      revision: 1,
      target: 'setting',
      quote: { start: 0, end: 2, text: '雨夜' },
    },
  })
  expect(queued.status).toBe(202)
  await queued.json()
  await request(owner.id, owner.cookie, {
    operationId: 'manual',
    baseRevision: 1,
    content: { ...content, setting: '清晨' },
  })
  first.push('可以。')
  first.finish()
  await drained
  await waitFor(() => calls.length >= 3)
  const snapshot = () =>
    app.handle(
      new Request(`http://localhost/api/agent/conversations/${owner.id}/messages`, {
        headers: { cookie: owner.cookie, 'x-device-id': 'production-device' },
      }),
    )
  await waitFor(async () => (await (await snapshot()).json()).activeTurn === null)
  const saved = await (
    await app.handle(
      new Request(
        `http://localhost/api/agent/conversations/${owner.id}/production?proposals=true`,
        { headers: { cookie: owner.cookie } },
      ),
    )
  ).json()
  expect(saved.document.content.setting).toBe('清晨')
  expect(saved.proposals).toEqual([])
  expect(JSON.stringify(calls[1]?.messages)).toContain('雨夜')
  expect(JSON.stringify(calls[1]?.messages)).toContain('\\"revision\\":1')
  setAgentFetchForTesting()
})
it('keeps a conflicting proposal available to inspect and discard', async () => {
  const owner = await account('production-conflict')
  const content = { title: '剧本', setting: '雨夜', outline: '', scenes: [] }
  const initial = await (
    await request(owner.id, owner.cookie, { operationId: 'first', baseRevision: 0, content })
  ).json()
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion({
            id: 'proposal',
            name: 'proposeProductionEdit',
            args: { replacement: '雪夜', requestQuote: '改成雪夜' },
          }),
        () => completionStream('建议已保存。'),
      ],
    ),
  )
  const turn = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${owner.id}/turns`, {
      method: 'POST',
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'production-device',
        text: '改成雪夜',
        params: {
          productionMode: true,
          production: { documentId: initial.document.id, revision: 1, target: 'setting' },
        },
      }),
    }),
  )
  await turn.text()
  const read = () =>
    app.handle(
      new Request(
        `http://localhost/api/agent/conversations/${owner.id}/production?proposals=true`,
        { headers: { cookie: owner.cookie } },
      ),
    )
  const proposal = (await (await read()).json()).proposals[0]
  await request(owner.id, owner.cookie, {
    operationId: 'manual',
    baseRevision: 1,
    content: { ...content, setting: '黄昏' },
  })
  const adopt = await app.handle(
    new Request(
      `http://localhost/api/agent/conversations/${owner.id}/production/proposals/${proposal.id}/adopt`,
      {
        method: 'POST',
        headers: { cookie: owner.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ operationId: 'adopt', baseRevision: 1 }),
      },
    ),
  )
  expect(adopt.status).toBe(409)
  expect((await adopt.json()).current.content.setting).toBe('黄昏')
  expect((await (await read()).json()).proposals[0].after).toBe('雪夜')
  const discard = await app.handle(
    new Request(
      `http://localhost/api/agent/conversations/${owner.id}/production/proposals/${proposal.id}/discard`,
      { method: 'POST', headers: { cookie: owner.cookie } },
    ),
  )
  expect(discard.status).toBe(200)
  const saved = await discard.json()
  expect(saved.document.revision).toBe(2)
  expect(saved.proposals[0].status).toBe('discarded')
  setAgentFetchForTesting()
})
it('turns a script into a proposed storyboard, then edits and reorders stable shots', async () => {
  const owner = await account('production-storyboard')
  const content = {
    title: '站台',
    setting: '雨夜',
    outline: '相遇',
    scenes: [{ id: 'platform', title: '站台', body: '她撑伞走来，列车开走。' }],
  }
  await request(owner.id, owner.cookie, { operationId: 'script', baseRevision: 0, content })
  const shots = [
    {
      id: 'approach',
      scriptSceneId: 'platform',
      lookIds: [],
      description: '远景，她撑伞走进站台。',
      camera: '缓慢推进',
      durationSeconds: 4,
    },
    {
      id: 'depart',
      scriptSceneId: 'platform',
      lookIds: [],
      description: '列车驶离。',
      dialogue: '下一班见。',
    },
  ]
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion({
            id: 'board-one',
            name: 'proposeStoryboard',
            args: { baseRevision: 1, shots, requestQuote: '把剧本转成分镜' },
          }),
        () => completionStream('分镜建议已准备好。'),
      ],
    ),
  )
  const turn = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${owner.id}/turns`, {
      method: 'POST',
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'production-device',
        text: '把剧本转成分镜',
        params: { productionMode: true },
      }),
    }),
  )
  await turn.text()
  const proposed = await (
    await app.handle(
      new Request(
        `http://localhost/api/agent/conversations/${owner.id}/production?storyboard=true`,
        { headers: { cookie: owner.cookie } },
      ),
    )
  ).json()
  expect(proposed.document.content.shots).toBeUndefined()
  expect(proposed.storyboardProposals).toHaveLength(1)
  const adopt = await app.handle(
    new Request(
      `http://localhost/api/agent/conversations/${owner.id}/production/storyboard/${proposed.storyboardProposals[0].id}/adopt`,
      {
        method: 'POST',
        headers: { cookie: owner.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ operationId: 'adopt-board', baseRevision: 1 }),
      },
    ),
  )
  expect(adopt.status).toBe(200)
  const adopted = await adopt.json()
  const replay = await app.handle(
    new Request(
      `http://localhost/api/agent/conversations/${owner.id}/production/storyboard/${proposed.storyboardProposals[0].id}/adopt`,
      {
        method: 'POST',
        headers: { cookie: owner.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ operationId: 'adopt-board', baseRevision: 1 }),
      },
    ),
  )
  expect((await replay.json()).document.revision).toBe(2)
  expect(adopted.document.content.shots.map((shot: { id: string }) => shot.id)).toEqual([
    'approach',
    'depart',
  ])
  const edited = await request(owner.id, owner.cookie, {
    operationId: 'reorder',
    baseRevision: 2,
    content: {
      ...adopted.document.content,
      shots: [{ ...shots[1], description: '列车缓缓驶离雨中的站台。' }, shots[0]],
    },
  })
  expect(edited.status).toBe(200)
  const restored = await (await request(owner.id, owner.cookie)).json()
  expect(restored.document.content.shots.map((shot: { id: string }) => shot.id)).toEqual([
    'depart',
    'approach',
  ])
  expect(restored.document.content.shots[0].dialogue).toBe('下一班见。')
  expect(restored.document.content.shots[0].durationSeconds).toBeUndefined()
  const missing = await request(owner.id, owner.cookie, {
    operationId: 'bad-reference',
    baseRevision: 3,
    content: { ...restored.document.content, shots: [{ ...shots[0], lookIds: ['missing-look'] }] },
  })
  expect(missing.status).toBe(400)
  setAgentFetchForTesting()
})
it('retains broken storyboard references visibly while rejecting foreign media and stale changes', async () => {
  const owner = await account('storyboard-reference-owner')
  const stranger = await account('storyboard-reference-stranger')
  const content = {
    title: '长镜头',
    setting: '',
    outline: '',
    scenes: [],
    characters: [
      {
        id: 'hero',
        name: '旅人',
        description: '',
        looks: [{ id: 'raincoat', name: '雨衣', description: '' }],
      },
    ],
    locations: [{ id: 'station', name: '车站', description: '' }],
    shots: [
      {
        id: 'arrival',
        description: '雨声中，她缓缓走来。'.repeat(100),
        lookIds: ['raincoat'],
        locationId: 'station',
      },
    ],
  }
  expect(
    (await request(owner.id, owner.cookie, { operationId: 'first', baseRevision: 0, content }))
      .status,
  ).toBe(200)
  const removed = await request(owner.id, owner.cookie, {
    operationId: 'remove-role',
    baseRevision: 1,
    content: { ...content, characters: [] },
  })
  expect(removed.status).toBe(200)
  const persisted = (await (await request(owner.id, owner.cookie)).json()).document
  expect(persisted.content.shots[0].lookIds).toEqual(['raincoat'])
  expect(persisted.content.shots[0].description).toBe(content.shots[0].description)
  expect((await request(owner.id, stranger.cookie)).status).toBe(404)
  expect(
    (await request(owner.id, owner.cookie, { operationId: 'stale', baseRevision: 1, content }))
      .status,
  ).toBe(409)
  expect(
    (
      await request(owner.id, owner.cookie, {
        operationId: 'foreign',
        baseRevision: 2,
        content: {
          ...persisted.content,
          shots: [{ ...content.shots[0], keyframe: { kind: 'media', mediaId: 'foreign-media' } }],
        },
      })
    ).status,
  ).toBe(400)
  expect((await (await request(owner.id, owner.cookie)).json()).document.revision).toBe(2)
})
it('limits Agent storyboard suggestions to the frozen selected shot', async () => {
  const owner = await account('storyboard-selected')
  const shots = [
    { id: 'one', description: '第一镜头', lookIds: [] },
    { id: 'two', description: '第二镜头', lookIds: [] },
  ]
  const initial = await (
    await request(owner.id, owner.cookie, {
      operationId: 'first',
      baseRevision: 0,
      content: { title: '局部建议', setting: '', outline: '', scenes: [], shots },
    })
  ).json()
  const propose = async (nextShots: typeof shots, toolId: string) => {
    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () =>
            toolCallCompletion({
              id: toolId,
              name: 'proposeStoryboard',
              args: { baseRevision: 1, shots: nextShots, requestQuote: '修改这个镜头' },
            }),
          () => completionStream('已处理。'),
        ],
      ),
    )
    const turn = await app.handle(
      new Request(`http://localhost/api/agent/conversations/${owner.id}/turns`, {
        method: 'POST',
        headers: { cookie: owner.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceId: 'production-device',
          text: '修改这个镜头',
          params: {
            productionMode: true,
            production: {
              documentId: initial.document.id,
              revision: 1,
              target: 'shot',
              shotId: 'one',
            },
          },
        }),
      }),
    )
    await turn.text()
    return (
      await app.handle(
        new Request(
          `http://localhost/api/agent/conversations/${owner.id}/production?storyboard=true`,
          { headers: { cookie: owner.cookie } },
        ),
      )
    ).json()
  }
  const rejected = await propose(
    [
      { ...shots[0]!, description: '已修改' },
      { ...shots[1]!, description: '越界修改' },
    ],
    'invalid-scope',
  )
  expect(rejected.storyboardProposals).toEqual([])
  const allowed = await propose([{ ...shots[0]!, description: '已修改' }, shots[1]!], 'valid-scope')
  expect(allowed.storyboardProposals).toHaveLength(1)
  expect(allowed.storyboardProposals[0].shots[1].description).toBe('第二镜头')
  expect(allowed.document.content.shots).toEqual(shots)
  setAgentFetchForTesting()
})
afterAll(async () => {
  await close()
  await rm(temp, { recursive: true, force: true })
})
