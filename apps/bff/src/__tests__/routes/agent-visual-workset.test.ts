import { afterAll, afterEach, beforeEach, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import { Elysia } from 'elysia'
import sharp from 'sharp'
import type { ObjectRangeReader } from '../../lib/objectStore'
import {
  type AgentCall,
  completionStream,
  eventsOfType,
  parseFrames,
  scriptedAgentFetch,
  toolCallCompletion,
} from '../helpers/agentStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

process.env.DATABASE_URL = await resetTestDatabase('bff_agent_visual_workset')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.AGENT_CHAT_CONTEXT_WINDOW = '64000'
process.env.AGENT_CHAT_MAX_TOKENS = '1000'
process.env.OPERATOR_CONFIG_FILE = resolve(
  import.meta.dir,
  '../agent-compaction-operator-config.json',
)
const { config } = await import('../../config')
const operator = config.operator
const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { close: closeDb, db, schema } = await import('../../db/client')
const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'
function post(path: string, body: unknown) {
  return app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}
function imageBlocks(call: AgentCall): number {
  return (JSON.stringify(call.messages).match(/"type":"image_url"/g) ?? []).length
}
beforeEach(async () => {
  setObjectStoreForTesting(new InMemoryObjectStore())
  await db.delete(schema.agent_conversations)
})
afterEach(() => {
  config.operator = operator
  setAgentFetchForTesting()
  setObjectStoreForTesting()
})
afterAll(async () => {
  await closeDb()
})

it('同轮保留联合证据，仅显式释放已看完图片并保留真实结论，随后可以重读', async () => {
  const calls: AgentCall[] = []
  setAgentFetchForTesting(scriptedAgentFetch(calls, [() => completionStream('图片已接收')]))
  const created = await post('/api/agent/conversations', { deviceId: DEVICE })
  const { conversation } = (await created.json()) as { conversation: { id: string } }
  const references = await Promise.all(
    ['a', 'b', 'c'].map(async (imageId, index) => ({
      imageId,
      dataUrl: `data:image/png;base64,${(
        await sharp({
          create: {
            width: 8,
            height: 8,
            channels: 4,
            background: ['#ff0000', '#00ff00', '#0000ff'][index]!,
          },
        })
          .png()
          .toBuffer()
      ).toString('base64')}`,
    })),
  )
  await (
    await post(`/api/agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '记下这些图片，稍后使用',
      references,
    })
  ).text()
  calls.length = 0
  setAgentFetchForTesting(
    scriptedAgentFetch(calls, [
      () =>
        toolCallCompletion(
          { id: 'look-a', name: 'viewImage', args: { imageIds: ['a'] } },
          { id: 'look-b', name: 'viewImage', args: { imageIds: ['b'] } },
        ),
      () =>
        toolCallCompletion({
          id: 'look-c',
          name: 'viewImage',
          args: {
            imageIds: ['c'],
            releaseImages: [{ imageId: 'a', observation: '图片 a 是纯红色，已完成单图颜色检查。' }],
          },
        }),
      () => toolCallCompletion({ id: 'reread-a', name: 'viewImage', args: { imageIds: ['a'] } }),
      () => completionStream('三张图已逐一查看，b 与 c 的联合证据保留。'),
    ]),
  )
  const response = await post(`/api/agent/conversations/${conversation.id}/turns`, {
    deviceId: DEVICE,
    text: '先看 a 和 b，再保留 b 看 c，最后重读 a。',
  })
  const frames = parseFrames(await response.text())
  expect(eventsOfType(frames, 'turnEnd')[0]).toMatchObject({ stopReason: 'completed' })
  expect(calls.map(imageBlocks)).toEqual([0, 2, 2, 3])
  expect(JSON.stringify(calls[1]!.messages).includes('图片 a 缩略图')).toBe(true)
  expect(JSON.stringify(calls[2]!.messages).includes('图片 a 是纯红色，已完成单图颜色检查。')).toBe(
    true,
  )
  expect(JSON.stringify(calls[2]!.messages).includes('a')).toBe(true)
})

it('本轮普通附件完成后可释放，刷新后的下一轮仍保留实际观察而不是只剩完成标题', async () => {
  const calls: AgentCall[] = []
  const observation = '红色附件的边缘没有文字；独立检查已经完成。'
  setAgentFetchForTesting(
    scriptedAgentFetch(calls, [
      () =>
        toolCallCompletion({
          id: 'finish-current',
          name: 'viewImage',
          args: { imageIds: ['b'], releaseImages: [{ imageId: 'a', observation }] },
        }),
      () => completionStream('继续检查第二张。'),
    ]),
  )
  const created = await post('/api/agent/conversations', { deviceId: DEVICE })
  const { conversation } = (await created.json()) as { conversation: { id: string } }
  const references = await Promise.all(
    ['a', 'b'].map(async (imageId, index) => ({
      imageId,
      dataUrl: `data:image/png;base64,${(
        await sharp({
          create: { width: 8, height: 8, channels: 4, background: index ? '#00ff00' : '#ff0000' },
        })
          .png()
          .toBuffer()
      ).toString('base64')}`,
    })),
  )
  const first = await post(`/api/agent/conversations/${conversation.id}/turns`, {
    deviceId: DEVICE,
    text: '分别检查两张图片的颜色与文字',
    references,
  })
  expect(eventsOfType(parseFrames(await first.text()), 'turnEnd')[0]).toMatchObject({
    stopReason: 'completed',
  })
  expect(JSON.stringify(calls[1]!.messages).includes('像素已按完成声明移出')).toBe(true)
  calls.length = 0
  setAgentFetchForTesting(scriptedAgentFetch(calls, [() => completionStream('延续已观察的事实。')]))
  await (
    await post(`/api/agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '刚才第一张检查到了什么？',
    })
  ).text()
  expect(JSON.stringify(calls[0]!.messages).includes(observation)).toBe(true)
  expect(imageBlocks(calls[0]!)).toBe(0)
})

it('图片格式转换失败时明确要求重新提供输入，不把原件回退派发给模型', async () => {
  const calls: AgentCall[] = []
  setAgentFetchForTesting(scriptedAgentFetch(calls, [() => completionStream('不应派发')]))
  const created = await post('/api/agent/conversations', { deviceId: DEVICE })
  const { conversation } = (await created.json()) as { conversation: { id: string } }
  const response = await post(`/api/agent/conversations/${conversation.id}/turns`, {
    deviceId: DEVICE,
    text: '请读出这张图里的小字，不要省略。',
    references: [
      {
        imageId: 'broken-avif',
        dataUrl: `data:image/avif;base64,${Buffer.from('broken-avif-image').toString('base64')}`,
      },
    ],
  })
  const ended = eventsOfType(parseFrames(await response.text()), 'turnEnd')[0]
  expect(calls).toHaveLength(0)
  expect(ended).toMatchObject({ stopReason: 'failed' })
  expect(ended?.failure?.message.includes('重新添加')).toBe(true)
})

it('一次读取四张历史图片时，真实对象读取并发受进程准备预算约束', async () => {
  class ObservedStore extends InMemoryObjectStore {
    active = 0
    maximum = 0
    override async open(key: string): Promise<ObjectRangeReader> {
      this.active += 1
      this.maximum = Math.max(this.maximum, this.active)
      try {
        // Controlled asynchronous I/O boundary, independent of wall-clock timing.
        await new Promise<void>((resolve) => setImmediate(resolve))
        return await super.open(key)
      } finally {
        this.active -= 1
      }
    }
  }
  const store = new ObservedStore()
  setObjectStoreForTesting(store)
  const calls: AgentCall[] = []
  setAgentFetchForTesting(scriptedAgentFetch(calls, [() => completionStream('已接收')]))
  const created = await post('/api/agent/conversations', { deviceId: DEVICE })
  const { conversation } = (await created.json()) as { conversation: { id: string } }
  const png = (
    await sharp({ create: { width: 8, height: 8, channels: 4, background: '#ff0000' } })
      .png()
      .toBuffer()
  ).toString('base64')
  const references = ['a', 'b', 'c', 'd'].map((imageId) => ({
    imageId,
    dataUrl: `data:image/png;base64,${png}`,
  }))
  await (
    await post(`/api/agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '稍后需要联合检查这四张图',
      references,
    })
  ).text()
  calls.length = 0
  store.maximum = 0
  setAgentFetchForTesting(
    scriptedAgentFetch(calls, [
      () =>
        toolCallCompletion({
          id: 'compare-four',
          name: 'viewImage',
          args: { imageIds: ['a', 'b', 'c', 'd'], retainImageIds: ['a', 'b', 'c', 'd'] },
        }),
      () => completionStream('四张联合证据均已看到。'),
    ]),
  )
  const result = await post(`/api/agent/conversations/${conversation.id}/turns`, {
    deviceId: DEVICE,
    text: '同时比较这四张图',
  })
  expect(eventsOfType(parseFrames(await result.text()), 'turnEnd')[0]).toMatchObject({
    stopReason: 'completed',
  })
  expect(imageBlocks(calls[1]!)).toBe(4)
  expect(store.maximum).toBe(1)
})

it('原图像素超过运行期预算时本地拒绝，不静默缩小细节或派发', async () => {
  config.operator = { ...operator, quotas: { ...operator.quotas, 'agent:visual-max-pixels': 4 } }
  const calls: AgentCall[] = []
  setAgentFetchForTesting(scriptedAgentFetch(calls, [() => completionStream('不应派发')]))
  const created = await post('/api/agent/conversations', { deviceId: DEVICE })
  const { conversation } = (await created.json()) as { conversation: { id: string } }
  const data = await sharp({ create: { width: 3, height: 3, channels: 4, background: '#ff0000' } })
    .png()
    .toBuffer()
  const response = await post(`/api/agent/conversations/${conversation.id}/turns`, {
    deviceId: DEVICE,
    text: '逐像素查看这张图，保留全部细节',
    references: [
      { imageId: 'detail', dataUrl: `data:image/png;base64,${data.toString('base64')}` },
    ],
  })
  const ended = eventsOfType(parseFrames(await response.text()), 'turnEnd')[0]
  expect(calls).toHaveLength(0)
  expect(ended).toMatchObject({ stopReason: 'failed' })
  expect(ended?.failure?.message.includes('像素')).toBe(true)
  expect(ended?.failure?.message.includes('选择')).toBe(true)
})

it('同一步连续图片工具在返回前执行工作集字节准入，未覆盖范围明确交给用户选择', async () => {
  const calls: AgentCall[] = []
  setAgentFetchForTesting(scriptedAgentFetch(calls, [() => completionStream('已保存附件')]))
  const created = await post('/api/agent/conversations', { deviceId: DEVICE })
  const { conversation } = (await created.json()) as { conversation: { id: string } }
  const png = await sharp(randomBytes(150 * 100 * 4), {
    raw: { width: 150, height: 100, channels: 4 },
  })
    .png()
    .toBuffer()
  const references = ['a', 'b', 'c', 'd'].map((imageId) => ({
    imageId,
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
  }))
  await (
    await post(`/api/agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '这些图片稍后联合比较',
      references,
    })
  ).text()
  calls.length = 0
  config.operator = {
    ...operator,
    quotas: { ...operator.quotas, 'agent:request-max-bytes': 220_000 },
  }
  const bodyBytes: number[] = []
  const scripted = scriptedAgentFetch(calls, [
    () =>
      toolCallCompletion(
        ...['a', 'b', 'c', 'd'].map((id) => ({
          id: `read-${id}`,
          name: 'viewImage',
          args: { imageIds: [id], detail: 'full', retainImageIds: ['a', 'b', 'c', 'd'] },
        })),
      ),
    () => completionStream('联合比较尚未完成，请选择需要共同查看的图片或必要区域。'),
  ])
  setAgentFetchForTesting(async (input, init) => {
    if (typeof init?.body === 'string') bodyBytes.push(Buffer.byteLength(init.body, 'utf8'))
    return scripted(input, init)
  })
  const response = await post(`/api/agent/conversations/${conversation.id}/turns`, {
    deviceId: DEVICE,
    text: '精细联合比较全部四张，不要降低细节。',
  })
  const frames = parseFrames(await response.text())
  const failures = eventsOfType(frames, 'toolEnd').filter((event) => event.status === 'failed')
  expect(failures).toHaveLength(2)
  expect(
    failures.every(
      (event) => event.message?.includes('未送入模型') && event.message.includes('选择'),
    ),
  ).toBe(true)
  expect(eventsOfType(frames, 'turnEnd')[0]).toMatchObject({ stopReason: 'completed' })
  expect(calls).toHaveLength(2)
  expect(imageBlocks(calls[1]!)).toBe(2)
  expect(bodyBytes.every((bytes) => bytes <= 220_000)).toBe(true)
})

it('活动选区和联合依赖不能释放，替换准入失败不清空旧证据，完成结论记录真实初轮出处', async () => {
  const calls: AgentCall[] = []
  setAgentFetchForTesting(scriptedAgentFetch(calls, [() => completionStream('保存历史图片')]))
  const created = await post('/api/agent/conversations', { deviceId: DEVICE })
  const { conversation } = (await created.json()) as { conversation: { id: string } }
  const noisy = `data:image/png;base64,${(
    await sharp(randomBytes(150 * 100 * 4), { raw: { width: 150, height: 100, channels: 4 } })
      .png()
      .toBuffer()
  ).toString('base64')}`
  const small = `data:image/png;base64,${(
    await sharp({ create: { width: 8, height: 8, channels: 4, background: '#ffffff' } })
      .png()
      .toBuffer()
  ).toString('base64')}`
  const mask = `data:image/png;base64,${(
    await sharp({ create: { width: 8, height: 8, channels: 4, background: '#00000000' } })
      .png()
      .toBuffer()
  ).toString('base64')}`
  await (
    await post(`/api/agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '稍后使用',
      references: [
        { imageId: 'd', dataUrl: noisy },
        { imageId: 'f', dataUrl: small },
      ],
    })
  ).text()
  calls.length = 0
  config.operator = {
    ...operator,
    quotas: { ...operator.quotas, 'agent:request-max-bytes': 220_000 },
  }
  setAgentFetchForTesting(
    scriptedAgentFetch(calls, [
      () =>
        toolCallCompletion(
          {
            id: 'keep-comparison',
            name: 'viewImage',
            args: { imageIds: ['f'], retainImageIds: ['b', 'c'] },
          },
          {
            id: 'release-selection',
            name: 'viewImage',
            args: {
              imageIds: ['f'],
              releaseImages: [{ imageId: 'e', observation: '不能释放活动选区' }],
            },
          },
          {
            id: 'release-comparison',
            name: 'viewImage',
            args: {
              imageIds: ['f'],
              releaseImages: [{ imageId: 'b', observation: '不能释放联合比较依赖' }],
            },
          },
          {
            id: 'oversized-replacement',
            name: 'viewImage',
            args: {
              imageIds: ['d'],
              detail: 'full',
              releaseImages: [{ imageId: 'a', observation: '这次替换失败不得记录为完成' }],
            },
          },
        ),
      () =>
        toolCallCompletion({
          id: 'finish-a',
          name: 'viewImage',
          args: {
            imageIds: ['f'],
            releaseImages: [{ imageId: 'a', observation: '图片 a 是纯白色，独立检查完成。' }],
          },
        }),
      () => completionStream('仅 a 已完成；活动选区与联合比较仍保留。'),
    ]),
  )
  const response = await post(`/api/agent/conversations/${conversation.id}/turns`, {
    deviceId: DEVICE,
    text: 'a 单独检查颜色，b 和 c 保留用于比较，e 的选区仍是当前目标。',
    references: [
      { imageId: 'a', dataUrl: small },
      { imageId: 'b', dataUrl: noisy },
      { imageId: 'c', dataUrl: noisy },
      { imageId: 'e', dataUrl: small, maskDataUrl: mask },
    ],
  })
  const frames = parseFrames(await response.text())
  expect(eventsOfType(frames, 'turnEnd')[0]).toMatchObject({ stopReason: 'completed' })
  expect(calls.map(imageBlocks)).toEqual([6, 7, 7])
  const tools = eventsOfType(frames, 'toolEnd')
  expect(tools.filter((event) => event.status === 'failed')).toHaveLength(3)
  expect(
    tools.find((event) => event.toolCallId === 'oversized-replacement')?.visualObservations,
  ).toBeUndefined()
  const observed = tools.find((event) => event.toolCallId === 'finish-a')?.visualObservations?.[0]
  expect(observed).toMatchObject({
    imageId: 'a',
    evidence: [
      { source: 'initial', representation: 'original', width: 8, height: 8, selection: false },
    ],
  })
  expect(observed?.evidence[0]?.bytes).toBeGreaterThan(0)
})

it('历史原件的存储元数据已经超预算时，不读取对象内容或假称已看过', async () => {
  const store = new InMemoryObjectStore()
  setObjectStoreForTesting(store)
  const calls: AgentCall[] = []
  setAgentFetchForTesting(scriptedAgentFetch(calls, [() => completionStream('已保存')]))
  const created = await post('/api/agent/conversations', { deviceId: DEVICE })
  const { conversation } = (await created.json()) as { conversation: { id: string } }
  const png = await sharp(randomBytes(200 * 200 * 4), {
    raw: { width: 200, height: 200, channels: 4 },
  })
    .png()
    .toBuffer()
  await (
    await post(`/api/agent/conversations/${conversation.id}/turns`, {
      deviceId: DEVICE,
      text: '稍后使用原件',
      references: [
        { imageId: 'large-history', dataUrl: `data:image/png;base64,${png.toString('base64')}` },
      ],
    })
  ).text()
  calls.length = 0
  store.events.length = 0
  config.operator = {
    ...operator,
    quotas: { ...operator.quotas, 'agent:request-max-bytes': 100_000 },
  }
  setAgentFetchForTesting(
    scriptedAgentFetch(calls, [
      () =>
        toolCallCompletion({
          id: 'large-original',
          name: 'viewImage',
          args: { imageIds: ['large-history'], detail: 'full' },
        }),
      () => completionStream('原件未读取，请选择必要区域或缩小比较范围。'),
    ]),
  )
  const response = await post(`/api/agent/conversations/${conversation.id}/turns`, {
    deviceId: DEVICE,
    text: '完整查看原件',
  })
  const frames = parseFrames(await response.text())
  expect(eventsOfType(frames, 'toolEnd')[0]).toMatchObject({ status: 'failed' })
  expect(calls.map(imageBlocks)).toEqual([0, 0])
  expect(
    store.events.some((event) => event.startsWith('read:') || event.startsWith('stream:')),
  ).toBe(false)
  expect(store.events.some((event) => event.startsWith('open:'))).toBe(true)
})

it('同一释放请求重复图片 id 时整组拒绝，后续仍能正常释放并保存观察', async () => {
  const calls: AgentCall[] = []
  setAgentFetchForTesting(
    scriptedAgentFetch(calls, [
      () =>
        toolCallCompletion({
          id: 'duplicate-release',
          name: 'viewImage',
          args: {
            imageIds: ['b'],
            releaseImages: [
              { imageId: 'a', observation: '红图已看完。' },
              { imageId: 'a', observation: '重复完成。' },
            ],
          },
        }),
      () =>
        toolCallCompletion({
          id: 'valid-release',
          name: 'viewImage',
          args: { imageIds: ['b'], releaseImages: [{ imageId: 'a', observation: '红图已确认。' }] },
        }),
      () => completionStream('继续检查 b。'),
    ]),
  )
  const created = await post('/api/agent/conversations', { deviceId: DEVICE })
  const { conversation } = (await created.json()) as { conversation: { id: string } }
  const png = (
    await sharp({ create: { width: 8, height: 8, channels: 4, background: '#ff0000' } })
      .png()
      .toBuffer()
  ).toString('base64')
  const response = await post(`/api/agent/conversations/${conversation.id}/turns`, {
    deviceId: DEVICE,
    text: '分别检查两张图片',
    references: ['a', 'b'].map((imageId) => ({ imageId, dataUrl: `data:image/png;base64,${png}` })),
  })
  const frames = parseFrames(await response.text())
  expect(calls.map(imageBlocks)).toEqual([2, 2, 2])
  expect(eventsOfType(frames, 'toolEnd').map((event) => event.status)).toEqual([
    'failed',
    'succeeded',
  ])
  expect(JSON.stringify(calls[2]!.messages).includes('红图已确认。')).toBe(true)
})
