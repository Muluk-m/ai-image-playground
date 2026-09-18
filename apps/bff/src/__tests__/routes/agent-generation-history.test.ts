import { afterAll, afterEach, beforeEach, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentMessageView, GenerationDetail } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import {
  _setPrivateBffOverlayForTesting,
  EMPTY_PRIVATE_BFF_OVERLAY,
} from '../../lib/private-overlay'
import {
  completionStream,
  controlledCompletion,
  eventsOfType,
  parseFrames,
  recordingAgentFetch,
  scriptedAgentFetch,
  TEST_IMAGE_CHANNEL,
  toolCallCompletion,
} from '../helpers/agentStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://localhost:9999'
process.env.UPSTREAM_API_KEY = 'fixture'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.DATABASE_URL = await resetTestDatabase('agent_generation_history')
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../project-conversations-operator-config.json',
)
const { app } = await import('../../app')
const { db, schema, close } = await import('../../db/client')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { setQueueTaskPollingForTesting } = await import('../../lib/taskSubmission')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { runTask } = await import('../../workers/task-runner')
const { setUpstreamFetchForTesting } = await import('../../lib/upstream')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { setDurableMediaStoreForTesting } = await import('../../lib/durableMediaStore')
class DurableFixture extends InMemoryObjectStore {
  sign(key: string) {
    return `https://durable.example/${key}`
  }
}
let deviceA: string
let deviceB: string
let stranger: string
let upstreamCalls: number
beforeEach(async () => {
  setObjectStoreForTesting(new InMemoryObjectStore())
  setDurableMediaStoreForTesting(new DurableFixture())
  _setChannelsForTesting([TEST_IMAGE_CHANNEL])
  setQueueTaskPollingForTesting({ intervalMs: 2, budgetMs: 10000 })
  await db.delete(schema.tasks)
  await db.delete(schema.users)
  for (const id of ['tool-owner', 'tool-stranger'])
    await db.insert(schema.users).values({
      id,
      username: id,
      password_hash: 'fixture',
      status: 'active',
      created_at: 1,
      updated_at: 1,
    })
  const session = async (id: string) =>
    `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession(id, tx))}`
  deviceA = await session('tool-owner')
  deviceB = await session('tool-owner')
  stranger = await session('tool-stranger')
  const bytes = await sharp({
    create: { width: 32, height: 24, channels: 4, background: '#77dd99' },
  })
    .png()
    .toBuffer()
  upstreamCalls = 0
  setUpstreamFetchForTesting(async () => {
    upstreamCalls++
    return Response.json({ data: [{ b64_json: bytes.toString('base64') }] })
  })
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion({
            id: 'generate-tool',
            name: 'generateImage',
            args: { prompt: '智能体历史归属验证', n: 1 },
          }),
        () => completionStream('图片已完成'),
      ],
    ),
  )
})
afterEach(() => {
  setAgentFetchForTesting()
  setQueueTaskPollingForTesting()
  setUpstreamFetchForTesting()
  setObjectStoreForTesting()
  setDurableMediaStoreForTesting()
})
afterAll(close)
function request(path: string, cookie = deviceA, body?: unknown, method = body ? 'POST' : 'GET') {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: { cookie, 'content-type': 'application/json', 'x-device-id': 'tool-history-device' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  )
}
async function project() {
  const id = crypto.randomUUID()
  expect(
    (
      await request(
        `/api/projects/${id}`,
        deviceA,
        {
          requestId: crypto.randomUUID(),
          baseRevision: 0,
          name: '历史原项目',
          document: { version: 1, elements: [] },
        },
        'PUT',
      )
    ).status,
  ).toBe(200)
  const { conversation } = await (
    await request(`/api/projects/${id}/conversation`, deviceA, {}, 'PUT')
  ).json()
  return { id, conversationId: conversation.id as string }
}
async function runTool(conversationId: string) {
  const response = await request(`/api/agent/conversations/${conversationId}/turns`, deviceA, {
    deviceId: 'tool-history-device',
    text: '生成一张图片',
  })
  if (!response.ok) throw new Error(await response.text())
  const reader = response.body!.getReader(),
    decoder = new TextDecoder()
  let payload = '',
    accepted: GenerationDetail | undefined
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      payload += decoder.decode(value, { stream: true })
      if (
        !accepted &&
        // 生图是后台任务：工具收尾时任务已经提交、还排着。
        parseFrames(payload).some(
          (frame) => frame.event.type === 'toolEnd' && frame.event.status === 'submitted',
        )
      ) {
        const page = await (await request('/api/generations', deviceB)).json()
        accepted = (await (
          await request(`/api/generations/${page.items[0].id}`, deviceB)
        ).json()) as GenerationDetail
        await runTask(accepted.id)
      }
    }
  } finally {
    await reader.cancel()
  }
  if (!accepted) throw new Error('tool did not submit')
  return { frames: parseFrames(payload), accepted }
}

it('真正工具任务冻结项目会话来源，会话轮本身不成为图片历史，临时任务清理后归属仍在', async () => {
  const original = await project()
  const { frames, accepted } = await runTool(original.conversationId)
  const turn = eventsOfType(frames, 'turnStart')[0]!
  expect(eventsOfType(frames, 'toolEnd')).toMatchObject([{ status: 'submitted' }])
  const source = {
    kind: 'agent',
    conversationId: original.conversationId,
    turnId: turn.turnId,
    projectId: original.id,
  }
  expect(accepted).toMatchObject({ source, status: 'queued' })
  const history = await (await request('/api/generations', deviceB)).json()
  expect(history.items).toHaveLength(1)
  expect(history.items[0]).toMatchObject({ id: accepted.id, source, status: 'completed' })
  await db.delete(schema.tasks).where(eq(schema.tasks.id, accepted.id))
  const retained = await (await request(`/api/generations/${accepted.id}`, deviceB)).json()
  expect(retained).toMatchObject({ source, status: 'completed', outputs: [{ index: 0 }] })
  expect((await request(`/api/generations/${accepted.id}`, stranger)).status).toBe(404)
  expect(upstreamCalls).toBe(1)
})

it('历史卡、会话卡与原项目共享产物身份，执行任务过期后仍能读原图', async () => {
  const original = await project()
  const { accepted } = await runTool(original.conversationId)
  // 任务跑完后读回会话，结果卡结算出产物。
  const settled = (await (
    await request(`/api/agent/conversations/${original.conversationId}/messages`, deviceB)
  ).json()) as { messages: AgentMessageView[] }
  const artifact = settled.messages
    .flatMap((message) => message.content)
    .flatMap((block) => (block.type === 'toolResult' ? (block.artifacts ?? []) : []))[0]!
  const retained = await (await request(`/api/generations/${accepted.id}`, deviceB)).json()
  const canvas = await (await request(`/api/projects/${original.id}`, deviceB)).json()
  expect(retained.outputs[0]).toMatchObject({
    artifactId: artifact.artifactId,
    index: artifact.outputIndex,
    mediaId: canvas.document.elements[0].mediaId,
  })
  expect(canvas.document.elements[0].id).toBe(artifact.artifactId)
  expect(retained.cover.artifactId).toBe(artifact.artifactId)
  const listed = await (await request('/api/generations', deviceB)).json()
  expect(listed.items[0].cover.artifactId).toBe(artifact.artifactId)
  await db.delete(schema.tasks).where(eq(schema.tasks.id, accepted.id))
  const image = await request(`/v1/queue/requests/${accepted.id}/image/0`, deviceB)
  expect(image.status).toBe(200)
  expect(image.headers.get('content-type')).toBe('image/png')
  expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(0)
  const messages = await (
    await request(`/api/agent/conversations/${original.conversationId}/messages`, deviceB)
  ).json()
  expect(JSON.stringify(messages)).toContain(artifact.artifactId)
  expect(upstreamCalls).toBe(1)
})

it('独立会话的工具产物不绑定另一个项目，也不混入其对话上下文', async () => {
  const other = await project()
  const response = await request('/api/agent/conversations', deviceA, {
    deviceId: 'tool-history-device',
  })
  expect(response.status).toBe(200)
  const { conversation } = await response.json()
  const { frames, accepted } = await runTool(conversation.id)
  const turn = eventsOfType(frames, 'turnStart')[0]!
  expect(accepted.source).toEqual({
    kind: 'agent',
    conversationId: conversation.id,
    turnId: turn.turnId,
    projectId: null,
  })
  const otherProject = await (await request(`/api/projects/${other.id}`, deviceB)).json()
  expect(otherProject.document.elements).toHaveLength(0)
  const otherMessages = await request(
    `/api/agent/conversations/${other.conversationId}/messages`,
    deviceB,
  )
  expect(otherMessages.status).toBe(200)
  expect(await otherMessages.text()).not.toContain(accepted.id)
  await runTask(accepted.id)
  const history = await (await request('/api/generations', deviceB)).json()
  expect(history.items).toHaveLength(1)
  expect(history.items[0].source).toEqual(accepted.source)
  expect(upstreamCalls).toBe(1)
})

it('运行中的项目不能被另一设备删除，回收与恢复同时隐藏和恢复原会话', async () => {
  const original = await project()
  const upstream = controlledCompletion()
  setAgentFetchForTesting(recordingAgentFetch([], (signal) => upstream.responseFor(signal)))
  const response = await request(
    `/api/agent/conversations/${original.conversationId}/turns`,
    deviceA,
    {
      deviceId: 'tool-history-device',
      text: '讨论草图',
    },
  )
  expect(response.status).toBe(200)
  try {
    const busy = await request(`/api/projects/${original.id}`, deviceB, undefined, 'DELETE')
    expect(busy.status).toBe(409)
    expect(await busy.json()).toMatchObject({ error: 'project_busy' })
  } finally {
    upstream.push('草图建议')
    upstream.finish()
    await response.text()
  }
  expect((await request(`/api/projects/${original.id}`, deviceB, undefined, 'DELETE')).status).toBe(
    200,
  )
  expect(
    (await request(`/api/agent/conversations/${original.conversationId}/messages`, deviceA)).status,
  ).toBe(404)
  expect(
    (await request(`/api/projects/${original.id}/conversation`, deviceA, {}, 'PUT')).status,
  ).toBe(410)
  expect(
    (await request(`/api/projects/${original.id}/restore`, stranger, undefined, 'POST')).status,
  ).toBe(404)
  expect((await request('/api/projects/trash', stranger)).status).toBe(200)
  expect((await (await request('/api/projects/trash', stranger)).json()).projects).toHaveLength(0)
  expect(
    (await request(`/api/projects/${original.id}/restore`, deviceB, undefined, 'POST')).status,
  ).toBe(200)
  const restored = await (await request(`/api/projects/${original.id}`, deviceA)).json()
  expect(restored.conversationId).toBe(original.conversationId)
  const messages = await request(
    `/api/agent/conversations/${original.conversationId}/messages`,
    deviceA,
  )
  expect(messages.status).toBe(200)
  expect(await messages.text()).toContain('草图建议')
})

it('无活动浏览器轮的排队任务仍阻止回收，结束后恢复同一图片和会话', async () => {
  const original = await project()
  const { accepted } = await runTool(original.conversationId)
  const before = await (await request(`/api/projects/${original.id}`, deviceA)).json()
  // Fixture models a worker-owned task left after its original BFF process exited.
  await db.update(schema.tasks).set({ status: 'queued' }).where(eq(schema.tasks.id, accepted.id))
  expect((await request(`/api/projects/${original.id}`, deviceB, undefined, 'DELETE')).status).toBe(
    409,
  )
  await db.update(schema.tasks).set({ status: 'completed' }).where(eq(schema.tasks.id, accepted.id))
  expect((await request(`/api/projects/${original.id}`, deviceB, undefined, 'DELETE')).status).toBe(
    200,
  )
  expect(
    (
      await request(
        `/api/agent/conversations/${original.conversationId}`,
        deviceA,
        { deviceId: 'tool-history-device' },
        'DELETE',
      )
    ).status,
  ).toBe(404)
  expect(
    (await request(`/api/projects/${original.id}/restore`, deviceB, undefined, 'POST')).status,
  ).toBe(200)
  const after = await (await request(`/api/projects/${original.id}`, deviceA)).json()
  expect(after.document).toEqual(before.document)
  expect(after.conversationId).toBe(before.conversationId)
  expect((await request(`/v1/queue/requests/${accepted.id}/image/0`, deviceB)).status).toBe(200)
  expect(upstreamCalls).toBe(1)
})
