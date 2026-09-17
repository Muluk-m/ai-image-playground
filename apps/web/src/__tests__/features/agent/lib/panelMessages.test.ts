import type {
  AgentClarificationBlock,
  AgentMessageRole,
  AgentMessageView,
  AgentToolArtifact,
  AgentToolResultBlock,
  AgentTurnEvent,
  AgentTurnSummaryView,
} from '@image-playground/shared'
import { describe, expect, it } from 'vitest'
import {
  type AgentPanelState,
  agentActivityPhase,
  answerableClarificationId,
  conversationStarted,
  dropUnsettledMessages,
  panelStateFromHistory,
  reduceAgentPanelEvent,
} from '../../../../features/agent/lib/panelMessages'
import type { AgentPanelMessage } from '../../../../features/agent/types'

const EMPTY: AgentPanelState = { messages: [], turns: {} }

/** 与 store 的 `follow` 同样的喂法：事件逐个进归约，轮标识来自 `turnStart`。 */
function replay(
  events: readonly AgentTurnEvent[],
  pendingUserText: string | null = null,
  initial: AgentPanelState = EMPTY,
): AgentPanelState {
  let state = initial
  let turnId = ''
  for (const event of events) {
    if (event.type === 'turnStart') turnId = event.turnId
    state = reduceAgentPanelEvent(state, event, { turnId, pendingUserText })
  }
  return state
}

const TURN = 'turn-1'
const USER_TEXT = '把[image 1]的背景换成浅木色，给我两版'

const FIRST: AgentToolArtifact = {
  artifactId: 'agent_image_1',
  media: 'image',
  taskId: 'task-1',
  outputIndex: 0,
  mime: 'image/png',
}
const SECOND: AgentToolArtifact = { ...FIRST, artifactId: 'agent_image_2', outputIndex: 1 }

/**
 * 后端一份块既发成 `toolEnd` 又落库（`apps/bff/src/lib/agent/turn.ts` 的 `toolResultBlock`：
 * 剥掉判别位当事件发，同一个对象 `storeBlock` 进消息表），所以这里也只写一份。
 */
const SUCCEEDED: AgentToolResultBlock = {
  type: 'toolResult',
  toolCallId: 'call-1',
  toolName: 'generateImage',
  status: 'succeeded',
  title: '浅木色背景的橘猫',
  prompt: '一只橘猫坐在浅木色背景前',
  artifacts: [FIRST, SECOND],
  anchorObjectId: 'canvas-1',
}
const FAILED: AgentToolResultBlock = {
  type: 'toolResult',
  toolCallId: 'call-2',
  toolName: 'generateVideo',
  status: 'failed',
  title: '视频：让这只猫眨眼',
  message: '上游拒绝了这次生成',
}
const ASKED: AgentClarificationBlock = {
  type: 'clarification',
  question: '视频要重试吗？',
  options: ['重试一次', '先算了'],
}

/** 事件发出去的样子：剥掉判别位，挂上这次调用独占的助手消息 id。 */
function toolEnd(block: AgentToolResultBlock, messageId: string): AgentTurnEvent {
  const { type: _block, ...fields } = block
  return { type: 'toolEnd', messageId, ...fields }
}

/** 落库的样子：一条助手消息只装一个块。 */
function stored(
  id: string,
  content: AgentMessageView['content'],
  role: AgentMessageRole = 'assistant',
): AgentMessageView {
  return { id, turnId: TURN, role, content, createdAt: 1 }
}

const COST = { chat: 3, image: 40, video: 0 }

/** 一轮：带引用的用户消息 → 助手文字 → 工具成功 → 工具失败 → 澄清 → 收尾文字 → 结算。 */
const LIVE: AgentTurnEvent[] = [
  { type: 'turnStart', turnId: TURN, userMessageId: 'user-1', reservedCredits: 60 },
  { type: 'assistantStart', messageId: 'assistant-1' },
  { type: 'textDelta', messageId: 'assistant-1', delta: '好的，' },
  { type: 'textDelta', messageId: 'assistant-1', delta: '我先出两版。' },
  {
    type: 'toolStart',
    messageId: 'tool-1',
    toolCallId: 'call-1',
    toolName: 'generateImage',
    title: SUCCEEDED.title,
    prompt: SUCCEEDED.prompt,
    outputCount: 2,
    anchorObjectId: 'canvas-1',
  },
  { type: 'toolProgress', messageId: 'tool-1', toolCallId: 'call-1', stage: 'running' },
  toolEnd(SUCCEEDED, 'tool-1'),
  {
    type: 'toolStart',
    messageId: 'tool-2',
    toolCallId: 'call-2',
    toolName: 'generateVideo',
    title: FAILED.title,
  },
  toolEnd(FAILED, 'tool-2'),
  { ...ASKED, messageId: 'clarify-1' },
  { type: 'assistantStart', messageId: 'assistant-2' },
  { type: 'textDelta', messageId: 'assistant-2', delta: '两版已经放到画布上了。' },
  {
    type: 'turnEnd',
    turnId: TURN,
    durationMs: 8_200,
    stopReason: 'completed',
    usage: null,
    cost: COST,
  },
]

const HISTORY = {
  messages: [
    stored(
      'user-1',
      [
        {
          type: 'text',
          text: USER_TEXT,
          references: [{ imageId: 'canvas-1', image: { object: 'ref/1', mime: 'image/png' } }],
        },
      ],
      'user',
    ),
    stored('assistant-1', [{ type: 'text', text: '好的，我先出两版。' }]),
    stored('tool-1', [SUCCEEDED]),
    stored('tool-2', [FAILED]),
    stored('clarify-1', [ASKED]),
    stored('assistant-2', [{ type: 'text', text: '两版已经放到画布上了。' }]),
  ],
  turns: [
    { turnId: TURN, durationMs: 8_200, stopReason: 'completed', cost: COST },
  ] satisfies AgentTurnSummaryView[],
}

const OPENING = '我先画一张。'

/** 多步失败轮：助手先说一句 → 起工具 → 工具失败中止整轮。 */
const FAILED_LIVE: AgentTurnEvent[] = [
  { type: 'turnStart', turnId: TURN, userMessageId: 'user-1' },
  { type: 'assistantStart', messageId: 'assistant-1' },
  { type: 'textDelta', messageId: 'assistant-1', delta: OPENING },
  {
    type: 'toolStart',
    messageId: 'tool-2',
    toolCallId: 'call-2',
    toolName: 'generateVideo',
    title: FAILED.title,
  },
  toolEnd(FAILED, 'tool-2'),
  {
    type: 'turnEnd',
    turnId: TURN,
    durationMs: 8,
    stopReason: 'failed',
    error: 'agent_tool_failed',
    usage: null,
  },
]

/** 同一轮后端真正落下去的：开场白在 `message_end` 就落库了，只有没收尾的那段不落。 */
const FAILED_HISTORY = {
  messages: [
    stored('user-1', [{ type: 'text', text: USER_TEXT }], 'user'),
    stored('assistant-1', [{ type: 'text', text: OPENING }]),
    stored('tool-2', [FAILED]),
  ],
  turns: [{ turnId: TURN, durationMs: 8, stopReason: 'failed' }] satisfies AgentTurnSummaryView[],
}

describe('历史与直播同源', () => {
  it('同一轮的事件序列与它落库的那几条消息归约出同一份面板', () => {
    const live = replay(LIVE, USER_TEXT)
    const history = panelStateFromHistory(HISTORY)

    // 逐字段相等，不忽略任何东西：直播专属的三样（streaming、stage、pending）都只在轮进行中
    // 存在——`turnEnd` 让文字收尾，`toolEnd` 整条换掉工具卡，`turnStart` 换掉待确认的用户消息。
    expect(live.messages).toEqual(history.messages)
    expect(live.messages.map((one) => one.id)).toEqual([
      'user-1',
      'assistant-1',
      'tool-1',
      'tool-2',
      'clarify-1',
      'assistant-2',
    ])
    // 页脚只差预扣：它是进行中的事，结算后的持久页脚里没有这一项。
    const { reservedCredits, ...footer } = live.turns[TURN]!
    expect(reservedCredits).toBe(60)
    expect({ [TURN]: footer }).toEqual(history.turns)
  })

  it('工具卡带上产物、锚点与失败原因，两条路各自都对', () => {
    expect(panelStateFromHistory(HISTORY).messages[2]).toEqual({
      kind: 'tool',
      id: 'tool-1',
      turnId: TURN,
      toolCallId: 'call-1',
      title: SUCCEEDED.title,
      prompt: SUCCEEDED.prompt,
      status: 'succeeded',
      artifacts: [FIRST, SECOND],
      anchorObjectId: 'canvas-1',
    })
    expect(replay(LIVE, USER_TEXT).messages[3]).toEqual({
      kind: 'tool',
      id: 'tool-2',
      turnId: TURN,
      toolCallId: 'call-2',
      title: FAILED.title,
      status: 'failed',
      message: FAILED.message,
    })
  })

  it('失败的一轮也同源：撤掉半截之后，与后端落库的那几条归约出同一份面板', () => {
    const live = replay(FAILED_LIVE, USER_TEXT)

    expect(dropUnsettledMessages(live.messages)).toEqual(
      panelStateFromHistory(FAILED_HISTORY).messages,
    )
  })

  it('澄清落在助手消息里，重新打开会话还能作答', () => {
    const history = panelStateFromHistory({
      messages: [
        stored('user-1', [{ type: 'text', text: '给我画个杯子' }], 'user'),
        stored('clarify-1', [ASKED]),
      ],
      turns: [],
    })
    expect(history.messages[1]).toEqual({
      kind: 'clarification',
      id: 'clarify-1',
      turnId: TURN,
      question: ASKED.question,
      options: ASKED.options,
    })
    expect(answerableClarificationId(history.messages)).toBe('clarify-1')
  })
})

describe('直播专属', () => {
  const START: AgentTurnEvent = { type: 'turnStart', turnId: TURN, userMessageId: 'user-1' }
  const pending: AgentPanelMessage = {
    kind: 'text',
    id: 'pending_1',
    turnId: 'pending_1',
    role: 'user',
    text: USER_TEXT,
    streaming: false,
    pending: true,
  }

  it('turnStart 把先上屏的那条换成服务端的 id', () => {
    const state = replay([START], USER_TEXT, { messages: [pending], turns: {} })

    expect(state.messages).toEqual([
      { kind: 'text', id: 'user-1', turnId: TURN, role: 'user', text: USER_TEXT, streaming: false },
    ])
  })

  it('用户消息已经在面板上时，重放的 turnStart 不再添一条', () => {
    const once = replay([START], USER_TEXT)
    const twice = replay([START, START], USER_TEXT)

    expect(twice.messages).toEqual(once.messages)
  })

  it('增量累加成一段话，轮结束才收尾', () => {
    const streaming = replay([
      START,
      { type: 'assistantStart', messageId: 'assistant-1' },
      { type: 'textDelta', messageId: 'assistant-1', delta: '好的，' },
      { type: 'textDelta', messageId: 'assistant-1', delta: '这就改' },
    ])
    expect(streaming.messages[1]).toMatchObject({ text: '好的，这就改', streaming: true })

    const ended = reduceAgentPanelEvent(
      streaming,
      { type: 'turnEnd', turnId: TURN, durationMs: 9, stopReason: 'completed', usage: null },
      { turnId: TURN, pendingUserText: null },
    )
    expect(ended.messages[1]).toMatchObject({ text: '好的，这就改', streaming: false })
  })

  it('认不出消息的增量原样放过，不凭空造一条', () => {
    const state = replay([START, { type: 'textDelta', messageId: 'ghost', delta: '喂' }])

    expect(state.messages.map((one) => one.id)).toEqual(['user-1'])
  })

  it('进度写到那次调用的卡上，结果到了连同 stage 一起换掉', () => {
    const running = replay([
      START,
      {
        type: 'toolStart',
        messageId: 'tool-1',
        toolCallId: 'call-1',
        toolName: 'generateImage',
        title: SUCCEEDED.title,
      },
      { type: 'toolProgress', messageId: 'tool-1', toolCallId: 'call-1', stage: 'running' },
    ])
    expect(running.messages[1]).toMatchObject({ status: 'running', stage: 'running' })

    const done = reduceAgentPanelEvent(running, toolEnd(SUCCEEDED, 'tool-1'), {
      turnId: TURN,
      pendingUserText: null,
    })
    expect(done.messages[1]).not.toHaveProperty('stage')
    expect(done.messages[1]).toMatchObject({ status: 'succeeded' })
  })

  it('续播只收到尾巴、没有 toolStart 时照样出卡', () => {
    const state = replay([START, toolEnd(SUCCEEDED, 'tool-1')])

    expect(state.messages[1]).toMatchObject({ id: 'tool-1', status: 'succeeded' })
  })

  it('插话的消息进对话流', () => {
    const state = replay([START, { type: 'interjection', messageId: 'user-2', text: '改成狗' }])

    expect(state.messages[1]).toEqual({
      kind: 'text',
      id: 'user-2',
      turnId: TURN,
      role: 'user',
      text: '改成狗',
      streaming: false,
    })
  })

  it('工具起跑、澄清与下一条回复都让此前那段话定稿', () => {
    const open: AgentTurnEvent[] = [
      START,
      { type: 'assistantStart', messageId: 'assistant-1' },
      { type: 'textDelta', messageId: 'assistant-1', delta: OPENING },
    ]

    const started = replay([
      ...open,
      {
        type: 'toolStart',
        messageId: 'tool-2',
        toolCallId: 'call-2',
        toolName: 'generateVideo',
        title: FAILED.title,
      },
    ])
    expect(started.messages[1]).toMatchObject({ text: OPENING, streaming: false })

    const asked = replay([...open, { ...ASKED, messageId: 'clarify-1' }])
    expect(asked.messages[1]).toMatchObject({ text: OPENING, streaming: false })

    const next = replay([...open, { type: 'assistantStart', messageId: 'assistant-2' }])
    expect(next.messages[1]).toMatchObject({ text: OPENING, streaming: false })
    expect(next.messages[2]).toMatchObject({ id: 'assistant-2', text: '', streaming: true })
  })

  it('重放同一个 assistantStart 不把那条正在流的话定稿，也不复制一条', () => {
    const streaming = replay([
      START,
      { type: 'assistantStart', messageId: 'assistant-1' },
      { type: 'textDelta', messageId: 'assistant-1', delta: OPENING },
      { type: 'assistantStart', messageId: 'assistant-1' },
      { type: 'textDelta', messageId: 'assistant-1', delta: OPENING },
    ])

    expect(streaming.messages.map((one) => one.id)).toEqual(['user-1', 'assistant-1'])
    expect(streaming.messages[1]).toMatchObject({ text: OPENING, streaming: true })
  })

  it('多步失败轮只撤没说完的那段，已经落库的开场白留在面板上', () => {
    const state = replay(FAILED_LIVE, USER_TEXT, { messages: [pending], turns: {} })
    const messages = dropUnsettledMessages(state.messages)

    expect(messages.map((one) => one.id)).toEqual(['user-1', 'assistant-1', 'tool-2'])
    expect(messages[1]).toMatchObject({ text: OPENING, streaming: false })
    expect(messages[2]).toMatchObject({ kind: 'tool', status: 'failed' })
  })

  it('单步失败轮里那段半截的话照旧撤掉', () => {
    const state = replay(
      [
        START,
        { type: 'assistantStart', messageId: 'assistant-1' },
        { type: 'textDelta', messageId: 'assistant-1', delta: '我先画' },
        {
          type: 'turnEnd',
          turnId: TURN,
          durationMs: 8,
          stopReason: 'failed',
          error: 'agent_upstream_error',
          usage: null,
        },
      ],
      USER_TEXT,
      { messages: [pending], turns: {} },
    )

    expect(dropUnsettledMessages(state.messages).map((one) => one.id)).toEqual(['user-1'])
  })

  it('只有工具调用、一个字都没有的那张卡失败时仍然撤掉', () => {
    const state = replay([
      START,
      { type: 'assistantStart', messageId: 'assistant-1' },
      {
        type: 'toolStart',
        messageId: 'tool-2',
        toolCallId: 'call-2',
        toolName: 'generateVideo',
        title: FAILED.title,
      },
      toolEnd(FAILED, 'tool-2'),
    ])

    expect(dropUnsettledMessages(state.messages).map((one) => one.id)).toEqual(['user-1', 'tool-2'])
  })

  it('轮失败时撤掉半截的回复与还没确认的那条', () => {
    const state = replay(
      [
        START,
        { type: 'assistantStart', messageId: 'assistant-1' },
        { type: 'textDelta', messageId: 'assistant-1', delta: '好的' },
        {
          type: 'turnEnd',
          turnId: TURN,
          durationMs: 8,
          stopReason: 'failed',
          error: 'agent_upstream_error',
          usage: null,
        },
      ],
      USER_TEXT,
      { messages: [pending], turns: {} },
    )

    expect(state.messages.map((one) => one.id)).toEqual(['user-1'])
    expect(state.turns[TURN]).toEqual({ turnId: TURN, durationMs: 8, stopReason: 'failed' })
  })
})

describe('面板查询', () => {
  const user: AgentPanelMessage = {
    kind: 'text',
    id: 'user-1',
    turnId: TURN,
    role: 'user',
    text: '画',
    streaming: false,
  }

  it('澄清之后有了用户消息就算作过答', () => {
    const asked: AgentPanelMessage = {
      kind: 'clarification',
      id: 'clarify-1',
      turnId: TURN,
      question: ASKED.question,
      options: ASKED.options,
    }
    expect(answerableClarificationId([user, asked])).toBe('clarify-1')
    expect(answerableClarificationId([user, asked, { ...user, id: 'user-2' }])).toBeNull()
    expect(answerableClarificationId([user])).toBeNull()
  })

  it('先上屏的那条就算会话开始了', () => {
    expect(conversationStarted([])).toBe(false)
    expect(conversationStarted([{ ...user, pending: true }])).toBe(true)
  })

  it('状态相位：起轮前发送中，等模型时思考中，工具跑着执行中，文字在流就让位', () => {
    expect(agentActivityPhase({ turn: 'idle', activeTurn: null, messages: [user] })).toBeNull()
    expect(agentActivityPhase({ turn: 'running', activeTurn: null, messages: [user] })).toBe(
      'sending',
    )
    const active = { turnId: TURN }
    expect(agentActivityPhase({ turn: 'running', activeTurn: active, messages: [user] })).toBe(
      'thinking',
    )
    expect(
      agentActivityPhase({ turn: 'running', activeTurn: active, messages: [user], stopping: true }),
    ).toBe('stopping')
    const tool: AgentPanelMessage = {
      kind: 'tool',
      id: 'tool-1',
      turnId: TURN,
      toolCallId: 'call-1',
      title: '生成图片',
      status: 'running',
    }
    expect(
      agentActivityPhase({ turn: 'running', activeTurn: active, messages: [user, tool] }),
    ).toBe('executing')
    const reply: AgentPanelMessage = {
      ...user,
      id: 'assistant-1',
      role: 'assistant',
      streaming: true,
    }
    expect(
      agentActivityPhase({ turn: 'running', activeTurn: active, messages: [user, reply] }),
    ).toBeNull()
    expect(
      agentActivityPhase({
        turn: 'running',
        activeTurn: active,
        messages: [user, { ...reply, text: '' }],
      }),
    ).toBe('thinking')
  })
})
