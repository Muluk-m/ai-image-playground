import { afterAll, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import {
  completionStream,
  scriptedAgentFetch,
  TEST_IMAGE_CHANNEL,
  toolCallCompletion,
} from '../helpers/agentStubs'
import { silenceChatUpstream } from '../helpers/chatStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'

const temp = await mkdtemp(join(tmpdir(), 'production-generation-'))
await writeFile(
  join(temp, 'operator.json'),
  JSON.stringify({
    capabilities: {
      'agent:chat': true,
      'agent:production': true,
      'generation:video': true,
      'billing:credits': true,
      'accounts:login': true,
      'accounts:sync': true,
    },
  }),
)
process.env.DATABASE_URL = await resetTestDatabase('production_generations')
process.env.OPERATOR_CONFIG_FILE = join(temp, 'operator.json')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
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
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
await silenceChatUpstream()
const storage = new InMemoryObjectStore()
setObjectStoreForTesting(storage)
_setChannelsForTesting([
  {
    ...TEST_IMAGE_CHANNEL,
    id: 'gemini',
    kind: 'gemini-queue',
    models: [{ id: 'gemini-fixture', label: 'Gemini', capabilities: ['generate', 'edit'] }],
  },
  {
    ...TEST_IMAGE_CHANNEL,
    id: 'video',
    models: [
      {
        id: 'grok-imagine-video',
        label: 'Video',
        media: 'video',
        capabilities: ['generate', 'reference_images'],
      },
    ],
  },
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
    locations: [{ id: 'room', name: '房间', description: '晚霞照进来' }],
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
  expect(
    (await request(owner, 'GET', '/references/preview?kind=asset&id=production-ref')).status,
  ).toBe(200)
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
  ).toBeUndefined()
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
it('creates a clip draft from its saved plan and rejects changed or missing shot inputs', async () => {
  billing.reset()
  const owner = await account('clip-generation-owner')
  const clip = {
    id: 'clip',
    name: '开场',
    shotIds: ['shot'],
    prompt: '镜头掠过雨夜街道',
    model: 'grok-imagine-video',
    video: { duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p' },
    references: [],
    sourceRevision: 0,
  }
  const content = {
    title: '雨夜',
    setting: '',
    outline: '',
    scenes: [],
    shots: [{ id: 'shot', description: '雨夜', lookIds: [] }],
    clips: [clip],
  }
  expect(
    (await request(owner, 'PUT', '', { operationId: 'initial', baseRevision: 0, content })).status,
  ).toBe(200)
  const input = {
    operationId: 'clip-draft',
    baseRevision: 1,
    target: 'clip',
    targetId: 'clip',
    prompt: clip.prompt,
    model: clip.model,
    video: clip.video,
    references: [],
  }
  const response = await request(owner, 'POST', '/generations', input)
  expect(response.status).toBe(200)
  const { generation } = await response.json()
  expect(generation.production.snapshot.shotIds).toEqual(['shot'])
  expect(generation.video).toEqual(clip.video)
  expect(billing.reservations).toHaveLength(0)
  expect(
    (
      await request(owner, 'POST', '/generations', {
        ...input,
        operationId: 'changed',
        prompt: '篡改计划',
      })
    ).status,
  ).toBe(400)
  expect(
    (
      await request(owner, 'PUT', '', {
        operationId: 'remove-shot',
        baseRevision: 1,
        content: { ...content, shots: [] },
      })
    ).status,
  ).toBe(200)
  expect(
    (
      await request(owner, 'POST', '/generations', {
        ...input,
        operationId: 'missing',
        baseRevision: 2,
      })
    ).status,
  ).toBe(400)
  const confirm = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${owner.id}/confirmations`, {
      method: 'POST',
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'production-device',
        messageId: generation.messageId,
        prompt: clip.prompt,
        draftRevision: 1,
      }),
    }),
  )
  expect(confirm.status).toBe(409)
  expect(billing.reservations).toHaveLength(0)
})
it('confirms a clip once and adopts only its completed video candidate', async () => {
  billing.reset()
  const owner = await account('clip-complete-owner')
  const clip = {
    id: 'clip',
    name: '开场',
    shotIds: ['shot'],
    prompt: '雨夜街道',
    model: 'grok-imagine-video',
    video: { duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p' },
    references: [],
    sourceRevision: 0,
  }
  await request(owner, 'PUT', '', {
    operationId: 'init',
    baseRevision: 0,
    content: {
      title: '雨夜',
      setting: '',
      outline: '',
      scenes: [],
      shots: [{ id: 'shot', description: '雨夜', lookIds: [] }],
      clips: [clip],
    },
  })
  const { generation } = await (
    await request(owner, 'POST', '/generations', {
      operationId: 'create',
      baseRevision: 1,
      target: 'clip',
      targetId: 'clip',
      prompt: clip.prompt,
      model: clip.model,
      video: clip.video,
      references: [],
    })
  ).json()
  const confirm = () =>
    app.handle(
      new Request(`http://localhost/api/agent/conversations/${owner.id}/confirmations`, {
        method: 'POST',
        headers: { cookie: owner.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceId: 'production-device',
          messageId: generation.messageId,
          prompt: clip.prompt,
          draftRevision: 1,
        }),
      }),
    )
  expect((await confirm()).status).toBe(200)
  expect((await confirm()).status).toBe(200)
  expect(billing.reservations).toHaveLength(1)
  const submitted = (await (await request(owner, 'GET', '/generations')).json()).generations[0]
  expect(submitted.taskId).toBeString()
  await workerSettles(submitted.taskId, {
    status: 'completed',
    resultPayload: {
      data: [{ url: 'https://cdn.test/clip.mp4', mime: 'video/mp4', duration_seconds: 5 }],
    },
  })
  const completed = (await (await request(owner, 'GET', '/generations')).json()).generations[0]
  expect(completed.artifacts[0].media).toBe('video')
  const current = (await (await request(owner, 'GET')).json()).document
  expect(
    (
      await request(owner, 'PUT', '', {
        operationId: 'video-as-image',
        baseRevision: current.revision,
        content: {
          ...current.content,
          locations: [
            {
              id: 'invalid',
              name: '场景',
              description: '',
              reference: { kind: 'artifact', artifactId: completed.artifacts[0].artifactId },
            },
          ],
        },
      })
    ).status,
  ).toBe(400)
  const adopt = () =>
    request(owner, 'POST', `/generations/${generation.draftId}/adopt`, {
      operationId: 'adopt',
      baseRevision: 1,
      artifactId: completed.artifacts[0].artifactId,
    })
  const result = await adopt()
  expect(result.status).toBe(200)
  expect((await result.json()).document.content.clips[0].adopted).toMatchObject({
    draftId: generation.draftId,
    artifactId: completed.artifacts[0].artifactId,
  })
  expect((await (await adopt()).json()).document.revision).toBe(2)
})
it('binds an Agent image draft to the selected production look without auto submitting', async () => {
  billing.reset()
  const owner = await account('context-owner')
  const content = {
    title: '角色',
    setting: '',
    outline: '',
    scenes: [],
    characters: [
      {
        id: 'c',
        name: '林',
        description: '',
        looks: [{ id: 'look', name: '雨衣', description: '黄色雨衣' }],
      },
    ],
  }
  const { document } = await (
    await request(owner, 'PUT', '', { operationId: 'init', baseRevision: 0, content })
  ).json()
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion({
            id: 'image-context',
            name: 'generateImage',
            args: { prompt: '黄色雨衣角色三视图' },
          }),
        () => completionStream('请确认。'),
      ],
    ),
  )
  try {
    const turn = await app.handle(
      new Request(`http://localhost/api/agent/conversations/${owner.id}/turns`, {
        method: 'POST',
        headers: { cookie: owner.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceId: 'production-device',
          text: '为选中的雨衣造型生成三视图',
          params: {
            model: TEST_IMAGE_CHANNEL.models[0]!.id,
            autoSubmit: true,
            productionMode: true,
            production: { documentId: document.id, revision: 1, target: 'look', lookId: 'look' },
          },
        }),
      }),
    )
    expect(turn.status).toBe(200)
    await turn.text()
    const { generations } = await (await request(owner, 'GET', '/generations')).json()
    expect(generations).toHaveLength(1)
    expect(generations[0]).toMatchObject({
      status: 'awaiting_confirmation',
      draftRevision: 1,
      production: { target: 'look', targetId: 'look' },
    })
    expect(
      billing.reservations.filter((one) => one.model === TEST_IMAGE_CHANNEL.models[0]!.id),
    ).toHaveLength(0)
  } finally {
    setAgentFetchForTesting()
  }
})
it('binds an Agent video draft to the frozen clip selection', async () => {
  billing.reset()
  const owner = await account('video-context-owner')
  const clip = {
    id: 'clip',
    name: '开场',
    shotIds: ['shot'],
    prompt: '雨夜街道',
    model: 'grok-imagine-video',
    video: { duration_seconds: 5, aspect_ratio: '16:9', resolution: '720p' },
    references: [],
    sourceRevision: 0,
  }
  const { document } = await (
    await request(owner, 'PUT', '', {
      operationId: 'init',
      baseRevision: 0,
      content: {
        title: '雨夜',
        setting: '',
        outline: '',
        scenes: [],
        shots: [{ id: 'shot', description: '雨夜', lookIds: [] }],
        clips: [clip],
      },
    })
  ).json()
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion({
            id: 'video-context',
            name: 'generateVideo',
            args: {
              prompt: clip.prompt,
              durationSeconds: 5,
              aspectRatio: '16:9',
              resolution: '720p',
            },
          }),
        () => completionStream('请确认。'),
      ],
    ),
  )
  try {
    const turn = await app.handle(
      new Request(`http://localhost/api/agent/conversations/${owner.id}/turns`, {
        method: 'POST',
        headers: { cookie: owner.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({
          deviceId: 'production-device',
          mode: 'video',
          text: '生成选中的视频片段',
          params: {
            model: clip.model,
            productionMode: true,
            production: { documentId: document.id, revision: 1, target: 'clip', clipId: 'clip' },
          },
        }),
      }),
    )
    expect(turn.status).toBe(200)
    await turn.text()
    const { generations } = await (await request(owner, 'GET', '/generations')).json()
    expect(generations).toHaveLength(1)
    expect(generations[0].production).toMatchObject({
      target: 'clip',
      targetId: 'clip',
      snapshot: { shotIds: ['shot'] },
    })
    expect(generations[0].video).toEqual(clip.video)
    expect(billing.reservations.filter((one) => one.model === clip.model)).toHaveLength(0)
  } finally {
    setAgentFetchForTesting()
  }
})
it('projects retry descendants with their frozen target and adopts the retry result explicitly', async () => {
  billing.reset()
  const owner = await account('retry-projection-owner')
  const content = {
    title: '场景',
    setting: '',
    outline: '',
    scenes: [],
    locations: [{ id: 'room', name: '房间', description: '晚霞' }],
  }
  await request(owner, 'PUT', '', { operationId: 'init', baseRevision: 0, content })
  await request(owner, 'PUT', '', { operationId: 'second-revision', baseRevision: 1, content })
  const { generation } = await (
    await request(owner, 'POST', '/generations', {
      operationId: 'create',
      baseRevision: 2,
      target: 'location',
      targetId: 'room',
      prompt: '房间',
      model: TEST_IMAGE_CHANNEL.models[0]!.id,
      references: [],
    })
  ).json()
  await app.handle(
    new Request(`http://localhost/api/agent/conversations/${owner.id}/confirmations`, {
      method: 'POST',
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'production-device',
        messageId: generation.messageId,
        prompt: '房间',
        draftRevision: 1,
      }),
    }),
  )
  const submitted = (await (await request(owner, 'GET', '/generations')).json()).generations[0]
  await workerSettles(submitted.taskId, {
    status: 'failed',
    errorType: 'upstream_timeout',
    errorMessage: 'upstream timeout',
  })
  const failed = (await (await request(owner, 'GET', '/generations')).json()).generations[0]
  expect(failed.errorCode).toBe('timeout')
  const retried = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${owner.id}/retries`, {
      method: 'POST',
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'production-device', messageId: generation.messageId }),
    }),
  )
  expect(retried.status).toBe(200)
  const views = (await (await request(owner, 'GET', '/generations')).json()).generations
  expect(views).toHaveLength(2)
  const retry = views.find((one: { taskId: string }) => one.taskId !== submitted.taskId)
  expect(retry.production).toEqual(generation.production)
  expect(retry.retryOf.messageId).toBe(generation.messageId)
  await workerSettles(retry.taskId, {
    status: 'completed',
    resultPayload: { data: [{ b64_json: 'aGk=', mime: 'image/png' }] },
  })
  const completed = (await (await request(owner, 'GET', '/generations')).json()).generations.find(
    (one: { taskId: string }) => one.taskId === retry.taskId,
  )
  expect(completed.sourceChanged).toBe(false)
  const exportInput = {
    revision: 2,
    references: [{ kind: 'artifact', artifactId: completed.artifacts[0].artifactId }],
  }
  expect((await request(owner, 'POST', '/export/inspect', exportInput)).status).toBe(200)
  expect(
    (await request(owner, 'POST', '/export/inspect', { ...exportInput, revision: 1 })).status,
  ).toBe(404)
  const foreign = await account('retry-export-stranger')
  expect(
    (await request({ ...owner, cookie: foreign.cookie }, 'POST', '/export/inspect', exportInput))
      .status,
  ).toBe(404)
  const bytes = await request(
    owner,
    'GET',
    `/export/reference?revision=2&kind=artifact&id=${encodeURIComponent(completed.artifacts[0].artifactId)}`,
  )
  expect(bytes.status).toBe(200)
  expect(await bytes.text()).toBe('hi')
  const adopted = await request(owner, 'POST', `/generations/${generation.draftId}/adopt`, {
    operationId: 'retry-adopt',
    baseRevision: 2,
    artifactId: completed.artifacts[0].artifactId,
  })
  expect(adopted.status).toBe(200)
  expect(
    (await (await request(owner, 'GET', '/generations')).json()).generations.find(
      (one: { taskId: string }) => one.taskId === retry.taskId,
    ).sourceChanged,
  ).toBe(false)
  const current = (await (await request(owner, 'GET')).json()).document
  await request(owner, 'PUT', '', {
    operationId: 'change',
    baseRevision: current.revision,
    content: {
      ...current.content,
      locations: current.content.locations.map((one: { description: string }) => ({
        ...one,
        description: '深夜',
      })),
    },
  })
  expect(
    (await (await request(owner, 'GET', '/generations')).json()).generations.find(
      (one: { taskId: string }) => one.taskId === retry.taskId,
    ).sourceChanged,
  ).toBe(true)
})
it('replays and edits an older draft after it leaves the bounded candidate list', async () => {
  const owner = await account('older-draft-owner')
  await request(owner, 'PUT', '', {
    operationId: 'init',
    baseRevision: 0,
    content: {
      title: '场景',
      setting: '',
      outline: '',
      scenes: [],
      locations: [{ id: 'room', name: '房间', description: '' }],
    },
  })
  const input = {
    operationId: 'oldest',
    baseRevision: 1,
    target: 'location',
    targetId: 'room',
    prompt: '房间',
    model: TEST_IMAGE_CHANNEL.models[0]!.id,
    references: [],
  }
  const { generation } = await (await request(owner, 'POST', '/generations', input)).json()
  for (let index = 0; index < 100; index++)
    expect(
      (await request(owner, 'POST', '/generations', { ...input, operationId: `later-${index}` }))
        .status,
    ).toBe(200)
  const replay = await (await request(owner, 'POST', '/generations', input)).json()
  expect(replay.generation.draftId).toBe(generation.draftId)
  const edited = await request(owner, 'PATCH', `/generations/${generation.draftId}`, {
    draftRevision: 1,
    prompt: '晨光房间',
    model: input.model,
    references: [],
  })
  expect(edited.status).toBe(200)
  expect((await edited.json()).generation.draftRevision).toBe(2)
})
afterAll(async () => {
  setObjectStoreForTesting()
  await close()
  await rm(temp, { recursive: true, force: true })
})

it('accepts the existing Gemini controls and rejects unsupported image parameters over HTTP', async () => {
  const owner = await account('generation-gemini-owner')
  expect(
    (
      await request(owner, 'PUT', '', {
        operationId: 'initial',
        baseRevision: 0,
        content: {
          title: '',
          setting: '',
          outline: '',
          scenes: [],
          locations: [{ id: 'room', name: 'Room', description: 'Wide room' }],
        },
      })
    ).status,
  ).toBe(200)
  const input = {
    operationId: 'gemini',
    baseRevision: 1,
    target: 'location',
    targetId: 'room',
    prompt: 'Wide room',
    model: 'gemini-fixture',
    references: [],
    params: {
      gemini_image_size: '512',
      gemini_aspect_ratio: '21:9',
      gemini_thinking_level: 'minimal',
    },
  }
  const response = await request(owner, 'POST', '/generations', input)
  expect(response.status).toBe(200)
  expect((await response.json()).generation.params).toEqual(input.params)
  for (const params of [
    { gemini_image_size: '8K' },
    { gemini_aspect_ratio: '99:1' },
    { quality: 'high' },
    { size: '1024x1024' },
  ]) {
    expect(
      (
        await request(owner, 'POST', '/generations', {
          ...input,
          operationId: JSON.stringify(params),
          params,
        })
      ).status,
    ).toBe(400)
  }
})
