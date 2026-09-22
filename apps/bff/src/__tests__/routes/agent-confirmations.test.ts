import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  type AgentMessageView,
  type AgentToolResultBlock,
  DEVICE_ID_HEADER,
} from '@image-playground/shared'
import { and, eq } from 'drizzle-orm'
import { Elysia } from 'elysia'
import sharp from 'sharp'
import { _setPrivateBffOverlayForTesting } from '../../lib/private-overlay'
import {
  type AgentCall,
  completionStream,
  parseFrames,
  scriptedAgentFetch,
  submittedPrompt,
  TEST_IMAGE_CHANNEL,
  toolCallCompletion,
} from '../helpers/agentStubs'
import { InMemoryObjectStore } from '../helpers/inMemoryObjectStore'
import { installRecordingTaskHooks } from '../helpers/privateOverlayStub'

process.env.DATABASE_URL = await resetTestDatabase('agent_confirmations_a300')
process.env.PORT = '0'
process.env.UPSTREAM_BASE_URL = 'http://gateway.test'
process.env.UPSTREAM_API_KEY = 'fixture-upstream-key'
process.env.UPSTREAM_OPENAI_API_KEY = ''
process.env.AGENT_CHAT_MODEL = 'fixture-agent-model'
process.env.OPERATOR_CONFIG_FILE = resolve(import.meta.dir, '../agent-video-operator-config.json')

const billing = installRecordingTaskHooks()

// Dynamic imports keep environment setup ahead of modules that capture configuration.
const { agentRoutes } = await import('../../routes/agent')
const { setAgentFetchForTesting } = await import('../../lib/agent/model')
const { setQueueTaskPollingForTesting } = await import('../../lib/taskSubmission')
const { _setChannelsForTesting } = await import('../../lib/channels')
const { setObjectStoreForTesting } = await import('../../lib/objectStore')
const { createUserSession, USER_SESSION_COOKIE } = await import('../../lib/user-session')
const { close: closeDb, db, schema } = await import('../../db/client')
const { imageSelection } = await import('../../lib/agent/selection-preview')
const { hydrateInputImages } = await import('../../lib/imageArchive')
const { setChatFetchForTesting, setChatRetryBackoffForTesting } = await import(
  '../../lib/chatCompletion'
)

/**
 * 会话自动命名走 chatCompletion（`lib/agent/start-turn.ts` 的 `nameConversation`），而测试里没有上游：
 * 不断掉它，每一轮都要做一次真 DNS 解析，失败后还按 500ms、1000ms 退避重试两次。那些计时器只会
 * 把每一轮的收尾窗口撑宽，2026-09-22 CI 这一份红（删会话撞上 409，根因已由 #775 修在服务端）就是
 * 在这种拖慢下暴露的。命名失败不影响这些用例：首句标题在事务里就落库了。
 */
setChatRetryBackoffForTesting(0)
setChatFetchForTesting(async () => new Response('no chat upstream in tests', { status: 503 }))

type InternalChannel = import('../../lib/channels').InternalChannel

const app = new Elysia().use(agentRoutes)
const DEVICE = 'device-abcdefgh'
const OTHER_DEVICE = 'device-hgfedcba'
const USER_ID = 'agent-confirm-user'
const OTHER_USER_ID = 'agent-confirm-intruder'
const CHAT_MODEL = 'fixture-agent-model'
const IMAGE_MODEL = TEST_IMAGE_CHANNEL.models[0]!.id
const VIDEO_MODEL = 'grok-imagine-video'

const PIXEL = `data:image/png;base64,${(
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#ffffff' } })
    .png()
    .toBuffer()
).toString('base64')}`
const MASK = `data:image/png;base64,${(
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: '#00000000' } })
    .png()
    .toBuffer()
).toString('base64')}`
const SELECTION_ID = (await imageSelection({ dataUrl: PIXEL, maskDataUrl: MASK }))!.id

/** 模型犯的那个错：用户只说了换浴缸，它替用户把颜色定成了浅灰绿。 */
const GREEN_DRAFT = '把主卫的白色浴缸换成浅灰绿色独立浴缸，软装同步改成浅灰绿色系'
const WHITE_PROMPT = '把主卫的浴缸换成同样的白色独立浴缸，软装保持原样，不要改变任何颜色'

const videoChannel: InternalChannel = {
  id: 'video-gateway',
  kind: 'openai-queue',
  label: 'Video',
  baseUrl: 'https://gateway.example/v1',
  auth: { type: 'bearer', secretRef: 'VIDEO_API_KEY', secret: 'k' },
  allowedPaths: ['videos/generations'],
  models: [{ id: VIDEO_MODEL, label: VIDEO_MODEL, media: 'video', capabilities: ['generate'] }],
  defaults: { asyncTasks: true },
}

let sessionToken = ''
let otherSessionToken = ''
let storage: InMemoryObjectStore

async function post(path: string, body: unknown, token = sessionToken, device = DEVICE) {
  const response = await app.handle(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [DEVICE_ID_HEADER]: device,
        cookie: `${USER_SESSION_COOKIE}=${token}`,
      },
      body: JSON.stringify(body),
    }),
  )
  return { status: response.status, json: await response.json() }
}

async function startConversation(): Promise<string> {
  const { status, json } = await post('/api/agent/conversations', { deviceId: DEVICE })
  expect(status).toBe(200)
  return (json as { conversation: { id: string } }).conversation.id
}

async function runTurn(
  conversationId: string,
  text: string,
  options: {
    references?: unknown[]
    mode?: 'image' | 'video'
    params?: Record<string, unknown>
  } = {},
) {
  const response = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${conversationId}/turns`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${USER_SESSION_COOKIE}=${sessionToken}`,
      },
      body: JSON.stringify({
        deviceId: DEVICE,
        text,
        references: options.references ?? [],
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.params ? { params: options.params } : {}),
      }),
    }),
  )
  const body = await response.text()
  if (!response.ok) throw new Error(`turn returned ${response.status}: ${body}`)
  return parseFrames(body)
}

async function readMessages(conversationId: string): Promise<AgentMessageView[]> {
  const response = await app.handle(
    new Request(`http://localhost/api/agent/conversations/${conversationId}/messages`, {
      headers: {
        [DEVICE_ID_HEADER]: DEVICE,
        cookie: `${USER_SESSION_COOKIE}=${sessionToken}`,
      },
    }),
  )
  return ((await response.json()) as { messages: AgentMessageView[] }).messages
}

function toolCards(messages: readonly AgentMessageView[]): {
  messageId: string
  block: AgentToolResultBlock
}[] {
  return messages.flatMap((message) =>
    message.content.flatMap((block) =>
      block.type === 'toolResult' ? [{ messageId: message.id, block }] : [],
    ),
  )
}

/** 拟稿之后那张等确认的卡。 */
async function pendingCard(conversationId: string) {
  const pending = toolCards(await readMessages(conversationId)).find(
    (card) => card.block.status === 'awaiting_confirmation',
  )
  expect(pending).toBeDefined()
  return pending!
}

function confirm(
  conversationId: string,
  messageId: string,
  prompt: string,
  token = sessionToken,
  device = DEVICE,
) {
  return post(
    `/api/agent/conversations/${conversationId}/confirmations`,
    { deviceId: device, messageId, prompt },
    token,
    device,
  )
}

function messageOf(json: unknown): AgentMessageView {
  return (json as { message: AgentMessageView }).message
}

function blockOf(json: unknown): AgentToolResultBlock {
  const block = messageOf(json).content.find(
    (one): one is AgentToolResultBlock => one.type === 'toolResult',
  )
  expect(block).toBeDefined()
  return block!
}

/** 这个会话建出来的生成任务。对话轮自己的那条 chat 任务不在此列。 */
function generationTasks(conversationId: string) {
  return db
    .select()
    .from(schema.tasks)
    .where(
      and(eq(schema.tasks.agent_conversation_id, conversationId), eq(schema.tasks.kind, 'queue')),
    )
}

/** 为生成预扣下的那几笔。对话模型的预扣与确认无关，不算在内。 */
function generationHolds() {
  return billing.reservations.filter((one) => one.model !== CHAT_MODEL)
}

/** 上游只被要求调一次工具；拟稿之后这一轮就该收尾，不会再问模型第二次。 */
function draftingTurn(calls: AgentCall[], name: string, args: Record<string, unknown>) {
  setAgentFetchForTesting(
    scriptedAgentFetch(calls, [() => toolCallCompletion({ id: 'call-1', name, args })]),
  )
}

beforeAll(async () => {
  const now = Date.now()
  await db.insert(schema.users).values([
    {
      id: USER_ID,
      username: 'agent.confirm',
      password_hash: 'hash',
      status: 'active',
      created_at: now,
      updated_at: now,
    },
    {
      id: OTHER_USER_ID,
      username: 'agent.intruder',
      password_hash: 'hash',
      status: 'active',
      created_at: now,
      updated_at: now,
    },
  ])
  sessionToken = await db.transaction((tx) => createUserSession(USER_ID, tx))
  otherSessionToken = await db.transaction((tx) => createUserSession(OTHER_USER_ID, tx))
})

// 每个用例自带会话，断言也按会话过滤：跑完不清库，免得清理与上一轮的收尾写入互相锁死。
beforeEach(() => {
  billing.reset()
  storage = new InMemoryObjectStore()
  setObjectStoreForTesting(storage)
  _setChannelsForTesting([TEST_IMAGE_CHANNEL, videoChannel])
  setQueueTaskPollingForTesting({ intervalMs: 2, budgetMs: 30_000 })
})

afterEach(() => {
  setAgentFetchForTesting()
  setQueueTaskPollingForTesting()
  setObjectStoreForTesting()
})

afterAll(async () => {
  setChatFetchForTesting()
  setChatRetryBackoffForTesting()
  _setPrivateBffOverlayForTesting()
  await closeDb()
})

describe('生成前确认', () => {
  it('拟稿不提交任务、不预扣积分，也不为它占画布', async () => {
    const calls: AgentCall[] = []
    draftingTurn(calls, 'generateImage', { prompt: GREEN_DRAFT, n: 2 })
    const conversationId = await startConversation()

    const frames = await runTurn(conversationId, '把主卫的浴缸换掉')

    expect(await generationTasks(conversationId)).toEqual([])
    expect(generationHolds()).toEqual([])
    expect(
      await db
        .select()
        .from(schema.agent_jobs)
        .where(eq(schema.agent_jobs.conversation_id, conversationId)),
    ).toEqual([])
    // 画布不占位：这一刻还没有东西会落下来。
    const start = frames.map((frame) => frame.event).find((event) => event.type === 'toolStart')
    expect(start).toMatchObject({ toolName: 'generateImage' })
    expect(start && 'outputCount' in start ? start.outputCount : undefined).toBeUndefined()
    // 拟完稿这一轮就收尾：不再多问模型一次。
    expect(calls).toHaveLength(1)

    const { block } = await pendingCard(conversationId)
    expect(block).toMatchObject({
      status: 'awaiting_confirmation',
      toolName: 'generateImage',
      prompt: GREEN_DRAFT,
    })
    // 待确认的卡没有任务可结算，也就不会被当成已完成。
    expect(block.job).toBeUndefined()
    expect(block.artifacts).toBeUndefined()
  })

  it('提交的是用户改过的那一句，不是模型写的浅灰绿色', async () => {
    const calls: AgentCall[] = []
    draftingTurn(calls, 'generateImage', { prompt: GREEN_DRAFT })
    const conversationId = await startConversation()
    await runTurn(conversationId, '把主卫的白色浴缸换成新的白色浴缸')
    const pending = await pendingCard(conversationId)

    const { status, json } = await confirm(conversationId, pending.messageId, WHITE_PROMPT)

    expect(status).toBe(200)
    const block = blockOf(json)
    // 卡就地改写：同一条消息、同一张卡，状态换成已提交。
    expect(messageOf(json).id).toBe(pending.messageId)
    expect(block).toMatchObject({
      status: 'submitted',
      toolCallId: pending.block.toolCallId,
      prompt: WHITE_PROMPT,
    })
    expect(block.job?.taskId).toBeTruthy()
    expect(block.snapshot?.target?.model).toBe(IMAGE_MODEL)
    // 标题跟着真正提交的那一句走：卡上那行不能还写着模型编的浅灰绿色。
    expect(pending.block.title).toContain('浅灰绿色')
    expect(block.title).not.toContain('浅灰绿色')
    expect(WHITE_PROMPT).toContain(block.title.replace('…', ''))

    const rows = await generationTasks(conversationId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.request_payload.prompt).toBe(submittedPrompt(WHITE_PROMPT))
    // 确认不再经过对话模型：上游只被问过拟稿那一次。
    expect(calls).toHaveLength(1)
    // 这时才预扣，且只扣一次。
    expect(generationHolds()).toHaveLength(1)
  })

  it('刷新后待确认的卡还在，确认后同一条消息变成已提交', async () => {
    const calls: AgentCall[] = []
    draftingTurn(calls, 'generateImage', { prompt: GREEN_DRAFT })
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一版')
    const pending = await pendingCard(conversationId)

    // 刷新：读回会话快照，卡还是待确认，没有被当成失败或成功结算掉。
    expect((await pendingCard(conversationId)).messageId).toBe(pending.messageId)

    await confirm(conversationId, pending.messageId, WHITE_PROMPT)

    const cards = toolCards(await readMessages(conversationId))
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({
      messageId: pending.messageId,
      block: { status: 'submitted', prompt: WHITE_PROMPT },
    })
  })

  it('别人的会话确认不了', async () => {
    const calls: AgentCall[] = []
    draftingTurn(calls, 'generateImage', { prompt: GREEN_DRAFT })
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一版')
    const pending = await pendingCard(conversationId)

    const intruder = await confirm(
      conversationId,
      pending.messageId,
      '偷偷换成别的',
      otherSessionToken,
      OTHER_DEVICE,
    )

    expect(intruder.status).toBe(404)
    expect(await generationTasks(conversationId)).toEqual([])
    expect((await pendingCard(conversationId)).block.status).toBe('awaiting_confirmation')
  })

  it('双击与并发确认只建一条任务', async () => {
    const calls: AgentCall[] = []
    draftingTurn(calls, 'generateImage', { prompt: GREEN_DRAFT })
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一版')
    const pending = await pendingCard(conversationId)

    const [first, second] = await Promise.all([
      confirm(conversationId, pending.messageId, WHITE_PROMPT),
      confirm(conversationId, pending.messageId, WHITE_PROMPT),
    ])
    const third = await confirm(conversationId, pending.messageId, '再改一次也不该再交一次')

    expect([first!.status, second!.status, third.status]).toEqual([200, 200, 200])
    const rows = await generationTasks(conversationId)
    expect(rows).toHaveLength(1)
    expect(generationHolds()).toHaveLength(1)
    // 三次拿到的是同一张卡、同一条任务，提示词仍是第一次确认的那一句。
    for (const answer of [first!, second!, third]) {
      expect(blockOf(answer.json).job?.taskId).toBe(rows[0]!.id)
      expect(blockOf(answer.json).prompt).toBe(WHITE_PROMPT)
    }
  })

  it('空提示词与超长提示词都不提交，草稿还留着', async () => {
    const calls: AgentCall[] = []
    draftingTurn(calls, 'generateImage', { prompt: GREEN_DRAFT })
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一版')
    const pending = await pendingCard(conversationId)

    const blank = await confirm(conversationId, pending.messageId, '   \n  ')
    const huge = await confirm(conversationId, pending.messageId, '很'.repeat(8_001))

    expect(blank.status).toBe(409)
    expect(blank.json).toEqual({ error: 'confirmation_refused', code: 'invalid_params' })
    expect(huge.status).toBe(409)
    expect(await generationTasks(conversationId)).toEqual([])
    expect(generationHolds()).toEqual([])
    // 稿子还在：改好再确认照样能提交。
    const ok = await confirm(conversationId, pending.messageId, WHITE_PROMPT)
    expect(ok.status).toBe(200)
    expect((await generationTasks(conversationId))[0]!.request_payload.prompt).toBe(
      submittedPrompt(WHITE_PROMPT),
    )
  })

  it('材料不在了的卡不提交，也不拿别的东西顶替', async () => {
    const calls: AgentCall[] = []
    draftingTurn(calls, 'generateImage', { prompt: GREEN_DRAFT })
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一版')
    const pending = await pendingCard(conversationId)
    await db
      .delete(schema.agent_generation_drafts)
      .where(eq(schema.agent_generation_drafts.conversation_id, conversationId))

    const answer = await confirm(conversationId, pending.messageId, WHITE_PROMPT)

    expect(answer.status).toBe(422)
    expect(answer.json).toEqual({ error: 'not_confirmable' })
    expect(await generationTasks(conversationId)).toEqual([])
    expect(generationHolds()).toEqual([])
  })

  it('会话删掉之后，确认不再把任务建进去', async () => {
    const calls: AgentCall[] = []
    draftingTurn(calls, 'generateImage', { prompt: GREEN_DRAFT })
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一版')
    const pending = await pendingCard(conversationId)
    const deleted = await app.handle(
      new Request(`http://localhost/api/agent/conversations/${conversationId}`, {
        method: 'DELETE',
        headers: {
          'content-type': 'application/json',
          cookie: `${USER_SESSION_COOKIE}=${sessionToken}`,
        },
        body: JSON.stringify({ deviceId: DEVICE }),
      }),
    )
    expect(deleted.status).toBe(200)

    const answer = await confirm(conversationId, pending.messageId, WHITE_PROMPT)

    expect(answer.status).toBe(404)
    expect(await generationTasks(conversationId)).toEqual([])
    expect(generationHolds()).toEqual([])
  })

  it('冻结的模型下线之后不替用户换一个', async () => {
    const calls: AgentCall[] = []
    draftingTurn(calls, 'generateImage', { prompt: GREEN_DRAFT })
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一版')
    const pending = await pendingCard(conversationId)
    // 运营把这个图片模型撤了：拟稿时冻结的那一个已经不在。
    _setChannelsForTesting([videoChannel])

    const answer = await confirm(conversationId, pending.messageId, WHITE_PROMPT)

    expect(answer.status).toBe(409)
    expect(answer.json).toEqual({ error: 'confirmation_refused', code: 'model_unavailable' })
    expect(await generationTasks(conversationId)).toEqual([])
    expect(generationHolds()).toEqual([])
    // 模型回来之后原样还能确认。
    _setChannelsForTesting([TEST_IMAGE_CHANNEL, videoChannel])
    const ok = await confirm(conversationId, pending.messageId, WHITE_PROMPT)
    expect(ok.status).toBe(200)
    expect((await generationTasks(conversationId))[0]!.request_payload.prompt).toBe(
      submittedPrompt(WHITE_PROMPT),
    )
  })

  it('积分不够时不建任务、不改卡，充值后还能确认', async () => {
    const calls: AgentCall[] = []
    draftingTurn(calls, 'generateImage', { prompt: GREEN_DRAFT })
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一版')
    const pending = await pendingCard(conversationId)
    billing.decide = (reservation) =>
      reservation.model === CHAT_MODEL
        ? undefined
        : { kind: 'insufficient_credits', required: 10, available: 0 }

    const refused = await confirm(conversationId, pending.messageId, WHITE_PROMPT)

    expect(refused.status).toBe(409)
    expect(refused.json).toEqual({ error: 'confirmation_refused', code: 'insufficient_credits' })
    expect(await generationTasks(conversationId)).toEqual([])
    expect((await pendingCard(conversationId)).block.status).toBe('awaiting_confirmation')

    billing.decide = null
    const ok = await confirm(conversationId, pending.messageId, WHITE_PROMPT)
    expect(ok.status).toBe(200)
    expect(await generationTasks(conversationId)).toHaveLength(1)
  })

  it('不是待确认的卡确认不了', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () => toolCallCompletion({ id: 'call-1', name: 'readLibrary', args: {} }),
        () => completionStream('素材库里没有可用的图'),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '看看素材库')
    const card = toolCards(await readMessages(conversationId))[0]
    expect(card?.block.status).not.toBe('awaiting_confirmation')

    const answer = await confirm(conversationId, card!.messageId, WHITE_PROMPT)

    expect(answer.status).toBe(422)
    expect(answer.json).toEqual({ error: 'not_confirmable' })
    const missing = await confirm(conversationId, 'no-such-message', WHITE_PROMPT)
    expect(missing.status).toBe(404)
    expect(missing.json).toEqual({ error: 'message_not_found' })
  })

  it('遮罩改图：拟的是服务端执行指令，确认时用户改的那一份连同遮罩一起提交', async () => {
    const calls: AgentCall[] = []
    draftingTurn(calls, 'editImage', {
      prompt: '换浴缸',
      imageIds: ['bath'],
      selectionBindings: [{ imageId: 'bath', selectionId: SELECTION_ID }],
    })
    const conversationId = await startConversation()
    await runTurn(conversationId, '把圈里的白色浴缸换成新的白色浴缸', {
      references: [{ imageId: 'bath', dataUrl: PIXEL, maskDataUrl: MASK }],
    })
    const pending = await pendingCard(conversationId)
    // 卡上给用户看的是真正会送进上游的执行指令，不是模型写的那句摘要。
    expect(pending.block.prompt).toContain('执行局部图像编辑')
    expect(pending.block.prompt).toContain('把圈里的白色浴缸换成新的白色浴缸')
    expect(pending.block.anchorObjectId).toBe('bath')

    const edited = `${pending.block.prompt}\n补充：保持白色，不要改成任何其它颜色。`
    const { status, json } = await confirm(conversationId, pending.messageId, edited)

    expect(status).toBe(200)
    expect(blockOf(json).prompt).toBe(edited)
    const rows = await generationTasks(conversationId)
    expect(rows).toHaveLength(1)
    // 用户改的那一份原样送出，不会被拟稿时的授权原文重新生成一遍。
    const request = await hydrateInputImages(rows[0]!.request_payload)
    expect(request.prompt).toBe(submittedPrompt(edited))
    // 遮罩与选区外像素保护照样在：确认只换提示词，不松边界。
    expect(rows[0]!.request_payload.preserve_outside_mask).toBe(true)
    expect(rows[0]!.request_payload.mask).toBeDefined()
    expect(request.input_images?.[0]).toBeTruthy()
    // 局部改图的候选必须复核：这个选择随草稿冻结，确认时照样落到任务登记上。
    const [job] = await db
      .select()
      .from(schema.agent_jobs)
      .where(eq(schema.agent_jobs.task_id, rows[0]!.id))
    expect(job).toMatchObject({ tool_call_id: 'call-1', wake_on_success: true })
    expect(blockOf(json).job?.review).toBe(true)
  })

  it('生视频：档位随草稿冻结，确认后记在任务与卡上', async () => {
    const calls: AgentCall[] = []
    draftingTurn(calls, 'generateVideo', {
      prompt: '镜头缓缓推近浴缸',
      durationSeconds: 5,
      resolution: '720p',
      aspectRatio: '9:16',
    })
    const conversationId = await startConversation()
    await runTurn(conversationId, '让这张图动起来', { mode: 'video' })
    const pending = await pendingCard(conversationId)
    expect(pending.block.toolName).toBe('generateVideo')
    expect(await generationTasks(conversationId)).toEqual([])

    const { status, json } = await confirm(
      conversationId,
      pending.messageId,
      '镜头缓缓推近白色浴缸',
    )

    expect(status).toBe(200)
    expect(blockOf(json).job).toMatchObject({
      media: 'video',
      video: { model: VIDEO_MODEL, duration: 5, resolution: '720p', aspectRatio: '9:16' },
    })
    const rows = await generationTasks(conversationId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.model).toBe(VIDEO_MODEL)
    expect(rows[0]!.request_payload.prompt).toBe('镜头缓缓推近白色浴缸')
    expect(rows[0]!.request_payload.video).toMatchObject({
      duration_seconds: 5,
      resolution: '720p',
      aspect_ratio: '9:16',
    })
  })

  it('每张草稿各自确认，一次确认不会把另一张也提交出去', async () => {
    const calls: AgentCall[] = []
    setAgentFetchForTesting(
      scriptedAgentFetch(calls, [
        () =>
          toolCallCompletion(
            { id: 'call-1', name: 'generateImage', args: { prompt: '白色浴缸 A' } },
            { id: 'call-2', name: 'generateImage', args: { prompt: '白色浴缸 B' } },
          ),
      ]),
    )
    const conversationId = await startConversation()
    await runTurn(conversationId, '给我两个方案')
    const cards = toolCards(await readMessages(conversationId))
    expect(cards.map((card) => card.block.status)).toEqual([
      'awaiting_confirmation',
      'awaiting_confirmation',
    ])

    await confirm(conversationId, cards[0]!.messageId, '方案 A：白色浴缸')

    const after = toolCards(await readMessages(conversationId))
    expect(after.map((card) => card.block.status)).toEqual(['submitted', 'awaiting_confirmation'])
    const rows = await generationTasks(conversationId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.request_payload.prompt).toBe(submittedPrompt('方案 A：白色浴缸'))
  })

  it('进程死在建任务与写回之间时，再确认认领原来那条任务而不是再交一次', async () => {
    const calls: AgentCall[] = []
    draftingTurn(calls, 'generateImage', { prompt: GREEN_DRAFT })
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一版')
    const pending = await pendingCard(conversationId)
    const first = await confirm(conversationId, pending.messageId, WHITE_PROMPT)
    const taskId = blockOf(first.json).job!.taskId

    // 模拟「任务建出来了，卡片与草稿都还没写回」：把两处写回都退回拟稿那一刻。
    await db
      .update(schema.agent_generation_drafts)
      .set({ task_id: null, confirmed_at: null })
      .where(eq(schema.agent_generation_drafts.conversation_id, conversationId))
    await db
      .update(schema.agent_messages)
      .set({ content: [pending.block] })
      .where(eq(schema.agent_messages.id, pending.messageId))

    const again = await confirm(conversationId, pending.messageId, '这次写点别的')

    expect(again.status).toBe(200)
    // 认领的是已经建出来的那条任务，提示词仍是它真正提交出去的那一句。
    expect(blockOf(again.json).job?.taskId).toBe(taskId)
    expect(blockOf(again.json).prompt).toBe(WHITE_PROMPT)
    expect(await generationTasks(conversationId)).toHaveLength(1)
    expect(generationHolds()).toHaveLength(1)
  })
  it('删掉会话时把参考图与草稿输入图一并清掉，不给待确认卡设过期', async () => {
    const calls: AgentCall[] = []
    draftingTurn(calls, 'editImage', { imageIds: ['[image 1]'], prompt: GREEN_DRAFT })
    const conversationId = await startConversation()
    await runTurn(conversationId, '换个颜色', { references: [{ imageId: 'bath', dataUrl: PIXEL }] })
    const [draft] = await db
      .select()
      .from(schema.agent_generation_drafts)
      .where(eq(schema.agent_generation_drafts.conversation_id, conversationId))
    expect(draft).toBeDefined()
    // 同一批字节躺在两处：参考图按会话存，草稿输入图按草稿存。
    expect((await storage.listPrefix(`agent/${conversationId}/`)).length).toBeGreaterThan(0)
    expect((await storage.listPrefix(`${draft!.id}/`)).length).toBeGreaterThan(0)

    const removed = await app.handle(
      new Request(`http://localhost/api/agent/conversations/${conversationId}`, {
        method: 'DELETE',
        headers: {
          'content-type': 'application/json',
          [DEVICE_ID_HEADER]: DEVICE,
          cookie: `${USER_SESSION_COOKIE}=${sessionToken}`,
        },
        body: JSON.stringify({ deviceId: DEVICE }),
      }),
    )
    expect(removed.status).toBe(200)

    expect(await storage.listPrefix(`agent/${conversationId}/`)).toEqual([])
    expect(await storage.listPrefix(`${draft!.id}/`)).toEqual([])
  })

  /**
   * 同一个内置模型、同一句提示词、同一组 chip 参数，走创作页和走智能体发给上游的必须是同一份。
   *
   * 期望值是创作页那条路的逐字输出：防改写 guard 前缀与构图指令由 `apps/web/src/lib/api.ts`
   * 的分发层钉上（这个模型没声明 `size` 能力，所以两段都有），`moderation` 由
   * `lib/channels/queueClient.ts` 无条件带上。哪一边漏掉一段，这里就红——两边出图质感对不上
   * 的根因正是这些看不见的差异。
   */
  it('确认后发给上游的提示词与审核强度，与创作页逐字相同', async () => {
    const calls: AgentCall[] = []
    draftingTurn(calls, 'generateImage', { prompt: GREEN_DRAFT })
    const conversationId = await startConversation()
    await runTurn(conversationId, '画一版竖构图', { params: { size: '1024x1536' } })
    const pending = await pendingCard(conversationId)
    // 摆在用户眼前、让他改的是干净的提示词：两段机器指令都不在卡上。
    expect(pending.block.prompt).toBe(GREEN_DRAFT)

    const { status, json } = await confirm(conversationId, pending.messageId, WHITE_PROMPT)

    expect(status).toBe(200)
    const [row] = await generationTasks(conversationId)
    expect(row!.request_payload).toMatchObject({
      prompt: `Use the following text as the complete prompt. Do not rewrite it:\n${WHITE_PROMPT}\n\nComposition: a tall 2:3 vertical frame, portrait orientation.`,
      size: '1024x1536',
      moderation: 'low',
    })
    // 改写过的卡面照旧只有用户确认的那一句。
    expect(blockOf(json).prompt).toBe(WHITE_PROMPT)
  })
})
