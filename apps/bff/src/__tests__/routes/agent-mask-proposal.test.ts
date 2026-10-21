import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import type { AgentClarificationBlock } from '@image-playground/shared'
import { eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import sharp from 'sharp'
import {
  type AgentCall,
  completionStream,
  eventsOfType,
  parseFrames,
  recordingAgentFetch,
  scriptedAgentFetch,
  toolCallCompletion,
} from '../helpers/agentStubs'
import { silenceChatUpstream } from '../helpers/chatStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'

process.env.DATABASE_URL = await resetTestDatabase('agent_mask_proposal_route')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-operator-config.json')

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { setQueueTaskPollingForTesting } = await import('../../lib/taskSubmission')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { setDurableMediaStoreForTesting } = await import('../../lib/durableMediaStore')
const { storeMedia } = await import('../../lib/projectMedia')
const { addConversationMediaClaims } = await import('../../lib/agent/images')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { close: closeDb, db, schema } = await import('../../db/client')
const { hydrateInputImages } = await import('../../lib/imageArchive')
const { imageSelection } = await import('../../lib/agent/selection-preview')
const { editMaskPng } = await import('../../lib/agent/mask-proposal')
const { setSegmentationProviderForTesting } = await import('../../lib/agent/segmentation')
const { setFastRegionRoutingForTesting } = await import('../../lib/agent/fast-region')
type SegmentationRequest = import('../../lib/agent/segmentation').SegmentationRequest
const { _setPrivateBffOverlayForTesting, EMPTY_PRIVATE_BFF_OVERLAY } = await import(
  '../../lib/private-overlay'
)

await silenceChatUpstream()
_setPrivateBffOverlayForTesting(EMPTY_PRIVATE_BFF_OVERLAY)

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'
const USER = '20000000-0000-4000-8000-000000000001'
const WIDTH = 1280
const HEIGHT = 960

const MASK_CHANNEL = {
  id: 'openai-images',
  kind: 'openai-queue' as const,
  label: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  auth: { type: 'bearer' as const, secretRef: 'OPENAI_API_KEY', secret: 'k' },
  allowedPaths: ['images/generations', 'images/edits'],
  models: [
    {
      id: 'gpt-image-2.5-flare',
      label: 'GPT Image 2.5 Flare',
      capabilities: ['generate' as const, 'edit' as const, 'mask' as const],
    },
    { id: 'agnes-image', label: 'Agnes', capabilities: ['generate' as const, 'edit' as const] },
  ],
  defaults: { apiMode: 'images' as const, timeout: 600 },
}

const ORIGINAL = await (async () => {
  const raw = Buffer.alloc(WIDTH * HEIGHT * 4)
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) {
      const tone = 128 + 70 * Math.sin(x / 31) * Math.cos(y / 27)
      raw.set([tone, (x * 3) % 256, (y * 5) % 256, 255], (y * WIDTH + x) * 4)
    }
  return sharp(raw, { raw: { width: WIDTH, height: HEIGHT, channels: 4 } })
    .png()
    .toBuffer()
})()
const TARGET = (() => {
  const target = new Uint8Array(WIDTH * HEIGHT)
  for (let y = 300; y < 700; y++) for (let x = 400; x < 900; x++) target[y * WIDTH + x] = 1
  return target
})()
const MASK = await editMaskPng(TARGET, WIDTH, HEIGHT)
const dataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`

let cookie: string

async function post(path: string, body: unknown) {
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
  )
  return { status: response.status, json: await response.json() }
}

async function runTurn(
  conversationId: string,
  text: string,
  references: unknown[],
  params: Record<string, unknown>,
) {
  const response = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${conversationId}/turns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ deviceId: DEVICE, text, params, references }),
    }),
  )
  const body = await response.text()
  if (!response.ok) throw new Error(`turn returned ${response.status}: ${body}`)
  return parseFrames(body)
}

beforeEach(async () => {
  setObjectStoreForTesting(new InMemoryObjectStore())
  setDurableMediaStoreForTesting(
    Object.assign(new InMemoryObjectStore(), { sign: (key: string) => `http://media.test/${key}` }),
  )
  _setChannelsForTesting([MASK_CHANNEL])
  setQueueTaskPollingForTesting({ intervalMs: 2, budgetMs: 30_000 })
  await db.delete(schema.tasks)
  await db.delete(schema.agent_conversations)
  await db.delete(schema.users)
  const now = Date.now()
  await db.insert(schema.users).values({
    id: USER,
    username: 'mask-user',
    password_hash: 'fixture-hash',
    status: 'active',
    created_at: now,
    updated_at: now,
  })
  cookie = `${USER_SESSION_COOKIE}=${await db.transaction((tx) => createUserSession(USER, tx))}`
})

afterEach(() => {
  setFastRegionRoutingForTesting()
  setSegmentationProviderForTesting()
  setAgentFetchForTesting()
  setQueueTaskPollingForTesting()
  setObjectStoreForTesting()
  setDurableMediaStoreForTesting()
})

afterAll(async () => {
  await closeDb()
})

describe('范围确认卡', () => {
  it('reports whether the segmenter is configured, without signing in', async () => {
    const response = await app.handle(
      new Request('http://localhost/api/agent/edit-region/segmenter'),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ configured: false })
  })

  it('asks for the region, then runs the strict masked edit with the confirmed mask', async () => {
    const { json } = await post('/api/agent/conversations', { deviceId: DEVICE })
    const conversationId = (json as { conversation: { id: string } }).conversation.id
    const original = await storeMedia(USER, ORIGINAL, 'image/png')
    await addConversationMediaClaims(conversationId, USER, [original.id])
    const reference = { imageId: original.id, mediaId: original.id }

    // 分割服务按 ≤1024 边长交回三张候选，BFF 选与框一致的那张、放大回原图再外扩。
    const segmented: SegmentationRequest[] = []
    setSegmentationProviderForTesting({
      id: 'edgetam',
      async segment(request) {
        segmented.push(request)
        const data = new Uint8Array(320 * 240)
        for (let y = 80; y < 170; y++) for (let x = 110; x < 210; x++) data[y * 320 + x] = 255
        return [{ data, width: 320, height: 240, score: 0.9 }]
      },
    })
    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () =>
          toolCallCompletion({
            id: 'propose',
            name: 'proposeEditRegion',
            args: {
              imageId: original.id,
              target: '杯身和把手',
              segmentPrompt: 'mug',
              change: '换成米白色釉面',
              keep: ['桌面'],
              box: { x: 0.3, y: 0.3, width: 0.4, height: 0.45 },
            },
          }),
        () => completionStream('不该走到这里'),
      ]),
    )
    const asked = await runTurn(conversationId, '把杯子改成米白色', [reference], {
      thinkingDepth: 'fast',
      model: 'agnes-image',
    })
    const [question] = eventsOfType(asked, 'clarification') as unknown as AgentClarificationBlock[]
    expect(question?.maskProposal).toMatchObject({
      imageId: original.id,
      mediaId: original.id,
      width: WIDTH,
      height: HEIGHT,
      target: '杯身和把手',
      segmentation: 'server',
      model: { id: 'gpt-image-2.5-flare' },
      switchedFrom: { id: 'agnes-image' },
    })
    const proposal = question!.maskProposal!
    expect(proposal.maskMediaId).toBeString()
    expect(segmented[0]).toMatchObject({
      key: `media:${original.id}`,
      width: WIDTH,
      height: HEIGHT,
    })

    // 卡片上点一下：在同一个区域上叠加用户的点重新分割，回原图尺寸的编辑格式蒙版。
    const refine = (id: string, body: Record<string, unknown>) =>
      post(`/api/agent/conversations/${conversationId}/edit-region/${id}/segment`, {
        deviceId: DEVICE,
        ...body,
      })
    const clicked = await refine(proposal.id, {
      points: [
        { x: 0.5, y: 0.5, include: true },
        { x: 0.68, y: 0.7, include: false },
      ],
    })
    expect(clicked.status).toBe(200)
    const refined = clicked.json as { mask: string; provider: string }
    expect(refined.provider).toBe('edgetam')
    const refinedMask = await sharp(Buffer.from(refined.mask.split(',')[1]!, 'base64'))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect([refinedMask.info.width, refinedMask.info.height]).toEqual([WIDTH, HEIGHT])
    expect(refinedMask.data[(500 * WIDTH + 640) * 4 + 3]).toBe(0)
    expect(refinedMask.data[(20 * WIDTH + 20) * 4 + 3]).toBe(255)
    expect(segmented.at(-1)?.points).toEqual([
      { x: 0.5, y: 0.5, include: true },
      { x: 0.68, y: 0.7, include: false },
    ])
    expect(
      (await refine('someone-else', { points: [{ x: 0.5, y: 0.5, include: true }] })).status,
    ).toBe(404)
    setSegmentationProviderForTesting(null)
    expect(
      (await refine(proposal.id, { points: [{ x: 0.5, y: 0.5, include: true }] })).status,
    ).toBe(503)
    // 提议发出后这一轮就停：轮到用户确认。
    expect(calls).toHaveLength(1)
    expect(await db.select().from(schema.tasks)).toHaveLength(0)

    // 用户在卡上确认：同一份原件按 id 引用，蒙版与原图同尺寸，标注只作编号区域。
    const mask = await storeMedia(USER, MASK, 'image/png')
    const selectionId = (await imageSelection({
      dataUrl: dataUrl(ORIGINAL),
      maskDataUrl: dataUrl(MASK),
    }))!.id
    // 确认那一轮不问模型：要改哪张、蒙版、改什么都已经定了，按提议直接提交。
    setAgentFetchForTesting(scriptedAgentFetch(calls, []))
    const answered = await runTurn(
      conversationId,
      '按确认的范围修改「杯身和把手」：换成米白色釉面\n标注 1（箭头）：把手内侧也要改',
      [
        {
          ...reference,
          maskMediaId: mask.id,
          editAction: 'inpaint',
          regions: [
            {
              number: 1,
              x: 0.6,
              y: 0.4,
              width: 0.04,
              height: 0.04,
              note: '把手内侧也要改',
              arrow: { x: 0.8, y: 0.2 },
            },
          ],
        },
      ],
      { thinkingDepth: 'fast', model: 'agnes-image' },
    )
    const [end] = eventsOfType(answered, 'toolEnd')
    // 卡上的「确认并生成」就是确认：直接提交，不再出待确认的稿。
    expect(end).toMatchObject({ toolName: 'editImage' })
    expect(end!.status).not.toBe('awaiting_confirmation')
    expect(end!.job?.taskId).toBeString()
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, end!.job!.taskId))
    expect(task!.model).toBe('gpt-image-2.5-flare')
    // 确认后默认出 2 张。
    expect(task!.request_payload.n).toBe(2)
    expect(task!.request_payload.preserve_outside_mask).toBe(true)
    const submitted = await hydrateInputImages(task!.request_payload)
    const [source] = submitted.input_images!
    const sourceMeta = await sharp(Buffer.from(source!.split(',')[1]!, 'base64')).metadata()
    const maskMeta = await sharp(Buffer.from(submitted.mask!.split(',')[1]!, 'base64')).metadata()
    // 原件没有被缩到 1920 以内再送去改：与原图同尺寸（只可能在右下补齐到 16 的倍数）。
    expect(sourceMeta.width).toBeGreaterThanOrEqual(WIDTH)
    expect(sourceMeta.height).toBeGreaterThanOrEqual(HEIGHT)
    expect([maskMeta.width, maskMeta.height]).toEqual([sourceMeta.width, sourceMeta.height])
    // 标注只进模型看的文字与定位图，不进送去生成的原图像素。
    const raw = await sharp(Buffer.from(source!.split(',')[1]!, 'base64'))
      .extract({ left: 0, top: 0, width: WIDTH, height: HEIGHT })
      .ensureAlpha()
      .raw()
      .toBuffer()
    expect(raw.equals(await sharp(ORIGINAL).ensureAlpha().raw().toBuffer())).toBe(true)
    expect(calls).toHaveLength(1)
    // 选区绑定按提议与蒙版现算，执行指令仍由服务端按用户原文（含标注）拼出来。
    expect(task!.request_payload.prompt).toContain('把手内侧也要改')
    expect(task!.request_payload.prompt).toContain(selectionId)
  }, 20_000)

  it('proposes on an inline upload by saving its original, and submits the confirmation without a model call', async () => {
    // 附件上传没开时用户的图随消息内联过来，云媒体里没有它的原件（浴缸那一单就是这样）。
    const { json } = await post('/api/agent/conversations', { deviceId: DEVICE })
    const conversationId = (json as { conversation: { id: string } }).conversation.id
    const imageId = 'file_bathtub'
    // 内联上限内的一份原件（与蒙版同尺寸）。
    const bath = await sharp(ORIGINAL).jpeg({ quality: 90 }).toBuffer()
    const inline = `data:image/jpeg;base64,${bath.toString('base64')}`
    setSegmentationProviderForTesting({
      id: 'edgetam',
      async segment() {
        const data = new Uint8Array(320 * 240)
        for (let y = 80; y < 170; y++) for (let x = 110; x < 210; x++) data[y * 320 + x] = 255
        return [{ data, width: 320, height: 240, score: 0.9 }]
      },
    })
    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () =>
          toolCallCompletion({
            id: 'propose',
            name: 'proposeEditRegion',
            args: {
              imageId,
              target: '浴缸',
              segmentPrompt: 'bathtub',
              change: '换一个浴缸，背景不变',
              keep: ['墙面', '地面'],
              box: { x: 0.3, y: 0.3, width: 0.4, height: 0.45 },
            },
          }),
        () => completionStream('不该走到这里'),
      ]),
    )
    const asked = await runTurn(
      conversationId,
      '我想把这个浴缸换一下背景不变那种',
      [{ imageId, dataUrl: inline }],
      { thinkingDepth: 'fast', model: 'agnes-image' },
    )
    const [question] = eventsOfType(asked, 'clarification') as unknown as AgentClarificationBlock[]
    const proposal = question?.maskProposal
    expect(proposal).toMatchObject({ imageId, width: WIDTH, height: HEIGHT, target: '浴缸' })
    expect(calls).toHaveLength(1)
    // 原件在服务端存成媒体、挂到会话上：卡片与点选都按这个 id 读同一份字节。
    const [stored] = await db
      .select()
      .from(schema.media_objects)
      .where(eq(schema.media_objects.id, proposal!.mediaId))
    expect(stored).toMatchObject({ user_id: USER, status: 'ready', bytes: bath.length })
    // 模型看的是缩略图，不是整份原件。
    const sent = JSON.stringify(calls[0]!.messages)
    expect(sent).not.toContain(bath.toString('base64').slice(0, 2000))

    // 卡上确认：网页把内联原件和蒙版一起带回来，这一轮不问模型，按提议直接提交。
    const answered = await runTurn(
      conversationId,
      '按确认的范围修改「浴缸」：换一个浴缸，背景不变',
      [{ imageId, dataUrl: inline, maskDataUrl: dataUrl(MASK), editAction: 'inpaint' }],
      { thinkingDepth: 'fast', model: 'agnes-image' },
    )
    expect(calls).toHaveLength(1)
    const [end] = eventsOfType(answered, 'toolEnd')
    expect(end).toMatchObject({ toolName: 'editImage' })
    expect(end!.status).not.toBe('awaiting_confirmation')
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, end!.job!.taskId))
    expect(task!.model).toBe('gpt-image-2.5-flare')
    expect(task!.request_payload.n).toBe(2)
    expect(task!.request_payload.preserve_outside_mask).toBe(true)
    expect(eventsOfType(answered, 'turnEnd')[0]).toMatchObject({ stopReason: 'completed' })
  }, 20_000)

  it('stops after one failed region proposal and tells the user, without retrying', async () => {
    const { json } = await post('/api/agent/conversations', { deviceId: DEVICE })
    const conversationId = (json as { conversation: { id: string } }).conversation.id
    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () =>
          toolCallCompletion({
            id: 'propose',
            name: 'proposeEditRegion',
            args: {
              imageId: 'file_wide',
              target: '浴缸',
              segmentPrompt: 'bathtub',
              change: '换一个浴缸',
              keep: [],
              box: { x: 0.3, y: 0.3, width: 0.4, height: 0.45 },
            },
          }),
        () => completionStream('请你在图上手动圈选浴缸'),
      ]),
    )
    // 严格蒙版模型改不了这么宽的原图：范围确认不可用。
    const wide = await sharp({
      create: { width: 4200, height: 1000, channels: 4, background: '#808080' },
    })
      .png()
      .toBuffer()
    const frames = await runTurn(
      conversationId,
      '把浴缸换一下',
      [{ imageId: 'file_wide', dataUrl: dataUrl(wide) }],
      { thinkingDepth: 'fast', model: 'agnes-image' },
    )
    expect(calls).toHaveLength(1)
    expect(eventsOfType(frames, 'clarification')).toHaveLength(0)
    const said = eventsOfType(frames, 'textDelta')
      .map((event) => (event as unknown as { delta: string }).delta)
      .join('')
    expect(said).toContain('没有改图')
    expect(said).not.toMatch(/手动|圈选后|自己画/)
    expect(await db.select().from(schema.tasks)).toHaveLength(0)
    const stored = await db
      .select()
      .from(schema.agent_messages)
      .where(eq(schema.agent_messages.conversation_id, conversationId))
    expect(JSON.stringify(stored.map((row) => row.content))).toContain('没有改图')
  }, 20_000)

  it('lets the fast tier pick the region while the configured tier runs alongside', async () => {
    setFastRegionRoutingForTesting(true)
    setSegmentationProviderForTesting({
      id: 'edgetam',
      async segment() {
        const data = new Uint8Array(320 * 240)
        for (let y = 80; y < 170; y++) for (let x = 110; x < 210; x++) data[y * 320 + x] = 255
        return [{ data, width: 320, height: 240, score: 0.9 }]
      },
    })
    const bath = await sharp(ORIGINAL).jpeg({ quality: 80 }).toBuffer()
    const inline = `data:image/jpeg;base64,${bath.toString('base64')}`
    const propose = () =>
      toolCallCompletion({
        id: 'propose',
        name: 'proposeEditRegion',
        args: {
          imageId: 'file_bathtub',
          target: '浴缸',
          segmentPrompt: 'bathtub',
          change: '换一个浴缸',
          keep: ['墙面'],
          box: { x: 0.3, y: 0.3, width: 0.4, height: 0.45 },
        },
      })
    const turn = async (fastAnswer: () => Response, mainAnswer: () => Response) => {
      const { json } = await post('/api/agent/conversations', { deviceId: DEVICE })
      const conversationId = (json as { conversation: { id: string } }).conversation.id
      const calls: AgentCall[] = []
      // 两条请求并发，按请求里的模型分别作答。
      const fast = recordingAgentFetch(calls, fastAnswer)
      const main = recordingAgentFetch(calls, mainAnswer)
      // 快档等当前档那条真发出去了再作答：否则快档赢得太早，当前档还没派发就被掐掉，记账条数不定。
      let mainSent!: () => void
      const mainDispatched = new Promise<void>((resolve) => {
        mainSent = resolve
      })
      setAgentFetchForTesting((async (input: string, init: { body: string }) => {
        if (JSON.parse(init.body).model === 'gpt-6-luna') {
          await mainDispatched
          return fast(input, init as RequestInit)
        }
        const response = main(input, init as RequestInit)
        mainSent()
        return response
      }) as unknown as typeof fetch)
      const frames = await runTurn(
        conversationId,
        '我想把这个浴缸换一下背景不变那种',
        [{ imageId: 'file_bathtub', dataUrl: inline }],
        { thinkingDepth: 'medium', model: 'agnes-image' },
      )
      const ledger = await db
        .select()
        .from(schema.agent_model_calls)
        .where(eq(schema.agent_model_calls.conversation_id, conversationId))
      return { frames, calls, ledger }
    }

    // 快档在框选：用它，当前档那一条掐掉；两条都记账。
    const won = await turn(propose, () => completionStream('当前档的回答'))
    expect(won.calls.map((call) => call.model).sort()).toEqual(['gpt-6-luna', 'gpt-6.1-sol'])
    expect(won.calls.find((call) => call.model === 'gpt-6-luna')?.reasoning_effort).toBe('low')
    const [question] = eventsOfType(
      won.frames,
      'clarification',
    ) as unknown as AgentClarificationBlock[]
    expect(question?.maskProposal?.target).toBe('浴缸')
    expect(won.ledger).toHaveLength(2)

    // 快档没在框选：照常用当前档的回答，快档那条只记账。
    const lost = await turn(
      () => completionStream('快档的回答'),
      () => completionStream('当前档的回答'),
    )
    const said = eventsOfType(lost.frames, 'textDelta')
      .map((event) => (event as unknown as { delta: string }).delta)
      .join('')
    expect(said).toBe('当前档的回答')
    expect(eventsOfType(lost.frames, 'clarification')).toHaveLength(0)
    expect(lost.ledger).toHaveLength(2)
  }, 20_000)

  it('does not let the agent edit the image without a mask while the region is pending', async () => {
    const { json } = await post('/api/agent/conversations', { deviceId: DEVICE })
    const conversationId = (json as { conversation: { id: string } }).conversation.id
    const original = await storeMedia(USER, ORIGINAL, 'image/png')
    await addConversationMediaClaims(conversationId, USER, [original.id])
    setAgentFetchForTesting(
      scriptedAgentFetch(
        [],
        [
          () =>
            toolCallCompletion(
              {
                id: 'propose',
                name: 'proposeEditRegion',
                args: {
                  imageId: original.id,
                  target: '杯子',
                  segmentPrompt: 'mug',
                  change: '换色',
                  box: { x: 0.3, y: 0.3, width: 0.4, height: 0.45 },
                },
              },
              {
                id: 'sneak',
                name: 'editImage',
                args: { prompt: '整张改成米白色', imageIds: [original.id] },
              },
            ),
          () => completionStream('好'),
        ],
      ),
    )
    const frames = await runTurn(
      conversationId,
      '把杯子改成米白色',
      [{ imageId: original.id, mediaId: original.id }],
      { thinkingDepth: 'fast' },
    )
    const [end] = eventsOfType(frames, 'toolEnd')
    expect(end).toMatchObject({ toolName: 'editImage', status: 'failed' })
    expect(end!.message).toContain('等用户确认')
    expect(await db.select().from(schema.tasks)).toHaveLength(0)
  })

  it('refuses a whole-image edit for a single-object request and has the agent propose the region', async () => {
    const { json } = await post('/api/agent/conversations', { deviceId: DEVICE })
    const conversationId = (json as { conversation: { id: string } }).conversation.id
    const bath = await sharp(ORIGINAL).jpeg({ quality: 80 }).toBuffer()
    const inline = `data:image/jpeg;base64,${bath.toString('base64')}`
    setSegmentationProviderForTesting({
      id: 'edgetam',
      async segment() {
        const data = new Uint8Array(320 * 240)
        for (let y = 80; y < 170; y++) for (let x = 110; x < 210; x++) data[y * 320 + x] = 255
        return [{ data, width: 320, height: 240, score: 0.9 }]
      },
    })
    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () =>
          toolCallCompletion({
            id: 'whole',
            name: 'editImage',
            args: { prompt: '把背景换成现代石材浴室', imageIds: ['file_bathtub'] },
          }),
        () =>
          toolCallCompletion({
            id: 'propose',
            name: 'proposeEditRegion',
            args: {
              imageId: 'file_bathtub',
              target: '浴缸',
              segmentPrompt: 'bathtub',
              change: '换一个浴缸，背景不变',
              box: { x: 0.3, y: 0.3, width: 0.4, height: 0.45 },
            },
          }),
        () => completionStream('不该走到这里'),
      ]),
    )
    const frames = await runTurn(
      conversationId,
      '我想把这个浴缸换一下背景不变那种',
      [{ imageId: 'file_bathtub', dataUrl: inline }],
      { thinkingDepth: 'fast', model: 'agnes-image' },
    )
    const [refused] = eventsOfType(frames, 'toolEnd')
    expect(refused).toMatchObject({ toolName: 'editImage', status: 'failed' })
    expect(refused!.message).toContain('proposeEditRegion')
    const [question] = eventsOfType(frames, 'clarification') as unknown as AgentClarificationBlock[]
    expect(question?.maskProposal).toMatchObject({ imageId: 'file_bathtub', target: '浴缸' })
    expect(calls).toHaveLength(2)
    expect(await db.select().from(schema.tasks)).toHaveLength(0)
  }, 20_000)

  it('still lets the agent edit the whole image for an overall request or an image too small to mask', async () => {
    const small = await sharp({
      create: { width: 320, height: 240, channels: 4, background: '#808080' },
    })
      .png()
      .toBuffer()
    const bath = await sharp(ORIGINAL).jpeg({ quality: 80 }).toBuffer()
    for (const [text, bytes, mime] of [
      ['把整张图调成黑白的', bath, 'image/jpeg'],
      ['把这个浴缸换一下', small, 'image/png'],
    ] as const) {
      const { json } = await post('/api/agent/conversations', { deviceId: DEVICE })
      const conversationId = (json as { conversation: { id: string } }).conversation.id
      setAgentFetchForTesting(
        scriptedAgentFetch(
          [],
          [
            () =>
              toolCallCompletion({
                id: 'whole',
                name: 'editImage',
                args: { prompt: text, imageIds: ['file_one'] },
              }),
            () => completionStream('好'),
          ],
        ),
      )
      const frames = await runTurn(
        conversationId,
        text,
        [{ imageId: 'file_one', dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }],
        { thinkingDepth: 'fast', model: 'agnes-image' },
      )
      const [end] = eventsOfType(frames, 'toolEnd')
      expect(end).toMatchObject({ toolName: 'editImage' })
      expect(end!.status).not.toBe('failed')
    }
  }, 20_000)
})
