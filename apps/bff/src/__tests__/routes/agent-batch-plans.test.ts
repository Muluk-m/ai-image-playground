import { afterAll, afterEach, beforeAll, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { DEVICE_ID_HEADER } from '@image-playground/shared'
import sharp from 'sharp'
import {
  type AgentCall,
  completionStream,
  eventsOfType,
  parseFrames,
  scriptedAgentFetch,
  TEST_IMAGE_CHANNEL,
  toolCallCompletion,
} from '../helpers/agentStubs'
import { silenceChatUpstream } from '../helpers/chatStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_batch_plans')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../batch-plan-operator-config.json')
const billing = installRecordingTaskHooks()
const { app } = await import('../../app')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { setDurableMediaStoreForTesting } = await import('../../lib/durableMediaStore')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { db, schema, close } = await import('../../db/client')
await silenceChatUpstream()

class MediaStorage extends InMemoryObjectStore {
  sign(key: string, method: 'GET' | 'PUT') {
    return `https://storage.example.test/${key}?method=${method}`
  }
}
const storage = new MediaStorage()
const DEVICE = 'batch-plan-device'
let cookie = ''

beforeAll(async () => {
  const now = Date.now()
  await db.insert(schema.users).values({
    id: 'batch-plan-owner',
    username: 'batch-plan-owner',
    password_hash: 'fixture',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession('batch-plan-owner', tx))}`
  setDurableMediaStoreForTesting(storage)
  setObjectStoreForTesting(new InMemoryObjectStore())
  _setChannelsForTesting([TEST_IMAGE_CHANNEL])
})
afterEach(() => setAgentFetchForTesting())
afterAll(close)

function request(
  path: string,
  body?: unknown,
  method = body ? 'POST' : 'GET',
  requestCookie = cookie,
) {
  return app.handle(
    new Request(`http://localhost/api/${path}`, {
      method,
      headers: {
        cookie: requestCookie,
        'content-type': 'application/json',
        [DEVICE_ID_HEADER]: DEVICE,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  )
}

async function upload(background: string) {
  const bytes = await sharp({ create: { width: 8, height: 6, channels: 4, background } })
    .png()
    .toBuffer()
  const response = await request('media/uploads', {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    contentType: 'image/png',
    purpose: 'conversation-attachment',
  })
  expect(response.status).toBe(200)
  const media = await response.json()
  await storage.write(new URL(media.uploadUrl).pathname.slice(1), bytes, 'image/png')
  expect((await request(`media/${media.id}/complete`, {})).status).toBe(200)
  return media.id as string
}

it('Agent 拟定两张图的固定计划，刷新恢复完整范围且不为生成预扣', async () => {
  const first = await upload('#123456')
  const second = await upload('#abcdef')
  const { conversation } = await (await request('agent/conversations', { deviceId: DEVICE })).json()
  const calls: AgentCall[] = []
  setAgentFetchForTesting(
    scriptedAgentFetch(calls, [
      () =>
        toolCallCompletion({
          id: 'batch-plan-1',
          name: 'planImageBatch',
          args: {
            title: '商品白底图',
            rule: '分别改成白色背景，保留商品细节',
            items: [
              {
                key: 'first',
                imageIds: ['first'],
                prompt: '第一张换白底，保持红色包装',
                dependencies: [],
              },
              {
                key: 'second',
                imageIds: ['second'],
                prompt: '第二张换白底，保持蓝色包装',
                dependencies: [],
              },
            ],
          },
        }),
      () => completionStream('已拟好批次计划，请审查。'),
    ]),
  )
  const response = await request(`agent/conversations/${conversation.id}/turns`, {
    deviceId: DEVICE,
    text: '给这两张商品图分别换白底，先给我完整计划',
    references: [
      { imageId: 'first', mediaId: first },
      { imageId: 'second', mediaId: second },
    ],
  })
  expect(response.status).toBe(200)
  const frames = parseFrames(await response.text())
  expect(eventsOfType(frames, 'turnEnd')[0]).toMatchObject({ stopReason: 'completed' })
  expect(calls[0]?.tools?.some((tool) => tool.function.name === 'planImageBatch')).toBe(true)
  const listResponse = await request(`agent/conversations/${conversation.id}/batches`)
  expect(listResponse.status).toBe(200)
  const { batches } = await listResponse.json()
  expect(batches).toHaveLength(1)
  const restored = await request(`agent/batches/${batches[0].id}`)
  expect(restored.status).toBe(200)
  const { batch, items } = await restored.json()
  expect(batch).toMatchObject({
    conversationId: conversation.id,
    experience: 'chat',
    version: 1,
    title: '商品白底图',
    rule: '分别改成白色背景，保留商品细节',
    itemCount: 2,
    status: 'draft',
    executionEnabled: false,
    estimate: { generation: { status: 'unavailable' } },
  })
  expect(batch.digest).toMatch(/^[a-f0-9]{64}$/)
  expect(items).toMatchObject([
    {
      key: 'first',
      ordinal: 0,
      prompt: '第一张换白底，保持红色包装',
      inputs: [{ imageId: 'first', mediaId: first }],
      dependencies: [],
    },
    {
      key: 'second',
      ordinal: 1,
      prompt: '第二张换白底，保持蓝色包装',
      inputs: [{ imageId: 'second', mediaId: second }],
      dependencies: [],
    },
  ])
  expect(billing.reservations.filter((entry) => entry.model !== 'fixture-agent-model')).toEqual([])
  expect(billing.reservations.some((entry) => entry.model === 'fixture-agent-model')).toBe(true)
})

it('修改生成新版本，旧版本写入冲突，翻页保持原版本顺序和内容', async () => {
  const first = await upload('#334455')
  const second = await upload('#556677')
  const { conversation } = await (await request('agent/conversations', { deviceId: DEVICE })).json()
  setAgentFetchForTesting(
    scriptedAgentFetch(
      [],
      [
        () =>
          toolCallCompletion({
            id: 'versioned-plan',
            name: 'planImageBatch',
            args: {
              title: '两张白底图',
              rule: '改白底',
              items: [
                { key: 'a', imageIds: ['a'], prompt: '原来的第一项', dependencies: [] },
                { key: 'b', imageIds: ['b'], prompt: '原来的第二项', dependencies: ['a'] },
              ],
            },
          }),
        () => completionStream('计划已保存'),
      ],
    ),
  )
  await (
    await request(`agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '先给这两张图拟计划',
      references: [
        { imageId: 'a', mediaId: first },
        { imageId: 'b', mediaId: second },
      ],
    })
  ).text()
  const { batches } = await (await request(`agent/conversations/${conversation.id}/batches`)).json()
  const path = `agent/batches/${batches[0].id}`
  const original = await (await request(path)).json()
  const firstPage = await (await request(`${path}?limit=1`)).json()
  expect(firstPage.items).toHaveLength(1)
  expect(firstPage.items[0].key).toBe('a')
  expect(firstPage.nextCursor).toBeString()
  const edit = {
    expectedVersion: 1,
    title: '更新后的计划',
    rule: '改浅灰底',
    items: original.items.map((item: { key: string; prompt: string }) => ({
      ...item,
      prompt: item.key === 'b' ? '第二项改成浅灰底' : item.prompt,
    })),
  }
  const savedResponse = await request(path, edit, 'PATCH')
  expect(savedResponse.status).toBe(200)
  const saved = await savedResponse.json()
  expect(saved.batch).toMatchObject({ version: 2, title: '更新后的计划', rule: '改浅灰底' })
  expect(saved.batch.digest).not.toBe(original.batch.digest)
  expect((await request(path, edit, 'PATCH')).status).toBe(409)
  const resumedPage = await (
    await request(`${path}?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`)
  ).json()
  expect(resumedPage.batch.version).toBe(1)
  expect(resumedPage.items).toMatchObject([
    { key: 'b', ordinal: 1, prompt: '原来的第二项', dependencies: ['a'] },
  ])
  expect(resumedPage.nextCursor).toBeNull()
  const refreshed = await (await request(path)).json()
  expect(refreshed.batch.version).toBe(2)
  expect(refreshed.items[1].prompt).toBe('第二项改成浅灰底')
})

it('只有属主能取消草稿，取消保留会话图片，删除会话后释放草稿引用', async () => {
  const now = Date.now()
  await db.insert(schema.users).values({
    id: 'batch-other',
    username: 'batch-other',
    password_hash: 'fixture',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  const otherCookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession('batch-other', tx))}`
  const { purgeExpiredAttachmentMedia } = await import('../../lib/projectMedia')
  for (const cancelFirst of [true, false]) {
    const mediaId = await upload(cancelFirst ? '#aa2233' : '#bb3344')
    const { conversation } = await (
      await request('agent/conversations', { deviceId: DEVICE })
    ).json()
    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () =>
            toolCallCompletion({
              id: 'cancel-plan',
              name: 'planImageBatch',
              args: {
                title: '待审查计划',
                rule: '换白底',
                items: [
                  { key: 'one', imageIds: ['one'], prompt: '换白底并保留包装', dependencies: [] },
                ],
              },
            }),
          () => completionStream('请审查计划'),
        ],
      ),
    )
    await (
      await request(`agent/conversations/${conversation.id}/turns`, {
        deviceId: DEVICE,
        text: '拟定计划',
        references: [{ imageId: 'one', mediaId }],
      })
    ).text()
    const { batches } = await (
      await request(`agent/conversations/${conversation.id}/batches`)
    ).json()
    const path = `agent/batches/${batches[0].id}`
    expect((await request(path, undefined, 'GET', otherCookie)).status).toBe(404)
    expect((await request(path, undefined, 'GET', '')).status).toBe(401)
    expect(
      (await request(`${path}/cancel`, { expectedVersion: 1 }, 'POST', otherCookie)).status,
    ).toBe(404)
    if (cancelFirst) {
      const cancelled = await request(`${path}/cancel`, { expectedVersion: 1 })
      expect(cancelled.status).toBe(200)
      expect(await cancelled.json()).toMatchObject({
        batch: { status: 'cancelled', executionEnabled: false },
      })
      expect((await request(`${path}/cancel`, { expectedVersion: 1 })).status).toBe(200)
      await purgeExpiredAttachmentMedia(Date.now() + 86400_000)
      expect((await request(`media/${mediaId}/access`)).status).toBe(200)
    }
    expect(
      (await request(`agent/conversations/${conversation.id}`, { deviceId: DEVICE }, 'DELETE'))
        .status,
    ).toBe(200)
    expect((await request(path)).status).toBe(404)
    await purgeExpiredAttachmentMedia(Date.now() + 86400_000)
    expect((await request(`media/${mediaId}/access`)).status).toBe(404)
  }
})
