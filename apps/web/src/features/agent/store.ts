import type {
  AgentActiveTurnView,
  AgentClarificationBlock,
  AgentConversationView,
  AgentFrame,
  AgentMessageView,
  AgentToolArtifact,
  AgentToolResultBlock,
  AgentTurnEvent,
  AgentTurnReference,
} from '@image-playground/shared'
import { agentMessageText } from '@image-playground/shared'
import { create } from 'zustand'
import { AGENT_CONVERSATION_KEY, safeLocalStorage, scopedStorageName } from '../../lib/authScope'
import {
  AgentRequestError,
  abortTurn,
  createConversation,
  fetchConversations,
  fetchMessages,
  fetchToolImage,
  interjectTurn,
  removeConversation,
  resumeTurn,
  startTurn,
  toolArtifactUrl,
} from './lib/agentClient'
import {
  type AgentPlacedArtifact,
  type AgentPlaceOptions,
  type AgentPlaceOutcome,
  agentCanvasSink,
} from './lib/canvasSink'
import { videoPosterDataUrl } from './lib/videoPoster'
import type {
  AgentClarificationMessage,
  AgentPanelMessage,
  AgentPanelTab,
  AgentToolMessage,
  AgentTurnFooter,
  AgentTurnStatus,
} from './types'

const TURN_FAILED = '这一轮没有跑完'
const TURN_RATE_LIMITED = '发送太频繁，稍后再试'

const RECONNECT_DELAYS_MS = [0, 500, 2_000, 5_000]

/** 登录后 scope 会变，所以每次现算，不缓存。 */
const conversationKey = () => scopedStorageName(AGENT_CONVERSATION_KEY)

export interface AgentState {
  open: boolean
  tab: AgentPanelTab
  conversationId: string | null
  conversations: AgentConversationView[]
  messages: AgentPanelMessage[]
  turns: Record<string, AgentTurnFooter>
  turn: AgentTurnStatus
  /** 正在跟的那一轮；中止与插话都指向它。 */
  activeTurn: AgentActiveTurnView | null
  error: string | null
  loaded: boolean
  expanded: Record<string, boolean>

  setOpen(open: boolean): void
  setTab(tab: AgentPanelTab): void
  toggleExpanded(messageId: string): void
  /** 读回会话列表与上次那个会话的消息，并挂回仍在进行的那一轮。 */
  load(): Promise<void>
  refreshConversations(): Promise<void>
  selectConversation(conversationId: string): Promise<void>
  deleteConversation(conversationId: string): Promise<void>
  startNewConversation(): void
  /** 空闲时起一轮；轮进行中则是插话（插话不带参考图）。 */
  send(text: string, references?: readonly AgentTurnReference[]): Promise<void>
  abort(): Promise<void>
  /** 画布冲突后由用户把那张结果卡的产出放进画布。 */
  placeOnCanvas(messageId: string): Promise<void>
}

function mergeTurn(
  turns: Record<string, AgentTurnFooter>,
  turnId: string,
  patch: Partial<AgentTurnFooter>,
): Record<string, AgentTurnFooter> {
  return { ...turns, [turnId]: { ...turns[turnId], turnId, ...patch } }
}

function replaceOrAppend(
  messages: AgentPanelMessage[],
  message: AgentPanelMessage,
): AgentPanelMessage[] {
  const index = messages.findIndex((one) => one.id === message.id)
  if (index < 0) return [...messages, message]
  return messages.map((one, at) => (at === index ? message : one))
}

function toolCard(block: AgentToolResultBlock, id: string, turnId: string): AgentToolMessage {
  return {
    kind: 'tool',
    id,
    turnId,
    toolCallId: block.toolCallId,
    title: block.title,
    status: block.status,
    ...(block.artifacts ? { artifacts: block.artifacts } : {}),
    ...(block.anchorObjectId ? { anchorObjectId: block.anchorObjectId } : {}),
    ...(block.message ? { message: block.message } : {}),
  }
}

function clarificationCard(
  block: AgentClarificationBlock,
  id: string,
  turnId: string,
): AgentClarificationMessage {
  return { kind: 'clarification', id, turnId, question: block.question, options: block.options }
}

function panelMessage(message: AgentMessageView): AgentPanelMessage {
  const result = message.content.find(
    (block): block is AgentToolResultBlock => block.type === 'toolResult',
  )
  if (result) return toolCard(result, message.id, message.turnId)
  const asked = message.content.find(
    (block): block is AgentClarificationBlock => block.type === 'clarification',
  )
  if (asked) return clarificationCard(asked, message.id, message.turnId)
  return {
    kind: 'text',
    id: message.id,
    turnId: message.turnId,
    role: message.role,
    text: agentMessageText(message),
    streaming: false,
  }
}

/**
 * 可作答的只有末尾那一条：澄清之后一旦有用户消息，它就已经作过答。
 * 回填的答案本身就是那条用户消息，所以不必另存作答状态。
 */
export function answerableClarificationId(messages: readonly AgentPanelMessage[]): string | null {
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const message = messages[at]!
    if (message.kind === 'text' && message.role === 'user') return null
    if (message.kind === 'clarification') return message.id
  }
  return null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const failPatch = (state: AgentState, message = TURN_FAILED) => ({
  turn: 'failed' as const,
  activeTurn: null,
  error: message,
  messages: state.messages.filter((one) => one.kind !== 'text' || !one.streaming),
})

/** `skipped`：没有画布，或这几张已经在上面了——续播会把同一条 `toolEnd` 重放给我们。 */
type LandOutcome = AgentPlaceOutcome | 'skipped' | 'failed'

/** 视频只取封面，mp4 留在服务端；图片整张下下来。 */
async function placeable(artifact: AgentToolArtifact): Promise<AgentPlacedArtifact> {
  const { artifactId, taskId, outputIndex } = artifact
  if (artifact.media !== 'video') return { artifactId, dataUrl: await fetchToolImage(artifact) }
  return {
    artifactId,
    dataUrl: await videoPosterDataUrl(toolArtifactUrl(artifact), artifact),
    video: { taskId, outputIndex },
  }
}

/** 把还没落画布的那几件产物取回来交给画布。 */
async function writeToCanvas(
  artifacts: readonly AgentToolArtifact[],
  options: AgentPlaceOptions,
): Promise<LandOutcome> {
  const sink = agentCanvasSink()
  if (!sink) return 'skipped'
  const missing = artifacts.filter((artifact) => !sink.has(artifact.artifactId))
  if (missing.length === 0) return 'skipped'
  // 判定归 place，这里只是别为一个已经定了的冲突白下几 MB。
  const { baseRevision } = options
  if (baseRevision !== undefined && sink.revision() !== baseRevision) return 'conflict'
  try {
    const items = await Promise.all(missing.map(placeable))
    return sink.place(items, options)
  } catch (thrown) {
    console.warn('[agent] 产出没能落到画布上', thrown)
    return 'failed'
  }
}

export const useAgentStore = create<AgentState>((set, get) => {
  // 落图排成一条链：帧循环不等它，文字流才不会被几 MB 的下载卡住；串起来则保住多张图的次序。
  let landing: Promise<void> = Promise.resolve()
  // 画布冲突的基线：跟上这一轮时的画布编辑修订号。
  let baseRevision: number | undefined

  const takeBaseRevision = () => {
    baseRevision = agentCanvasSink()?.revision()
  }

  const setConflict = (messageId: string, conflict: boolean) =>
    set((state) => ({
      messages: state.messages.map((one) =>
        one.kind === 'tool' && one.id === messageId
          ? { ...one, canvasConflict: conflict || undefined }
          : one,
      ),
    }))

  const land = async (
    artifacts: readonly AgentToolArtifact[],
    messageId: string,
    anchor?: string,
  ) => {
    const outcome = await writeToCanvas(artifacts, { baseRevision, anchorObjectId: anchor })
    if (outcome === 'conflict') setConflict(messageId, true)
    // 智能体自己的写入不算用户改动，所以基线跟到写后的值：
    // 不抬的话同一轮里的第二次落图会把第一次当成用户动了画布。
    else if (outcome === 'placed') takeBaseRevision()
  }

  /** 事件按 id 幂等：重连重发的帧、以及续播重放的整轮，都要落到同一个结果上。 */
  const apply = (event: AgentTurnEvent, pendingUserText: string | null, turnId: string) => {
    set((state) => {
      switch (event.type) {
        case 'turnStart':
          return {
            activeTurn: { turnId: event.turnId },
            turns: mergeTurn(
              state.turns,
              event.turnId,
              event.reservedCredits === undefined ? {} : { reservedCredits: event.reservedCredits },
            ),
            messages: state.messages.some((one) => one.id === event.userMessageId)
              ? state.messages
              : [
                  ...state.messages,
                  {
                    kind: 'text' as const,
                    id: event.userMessageId,
                    turnId,
                    role: 'user' as const,
                    text: pendingUserText ?? '',
                    streaming: false,
                  },
                ],
          }
        case 'assistantStart':
          return {
            messages: replaceOrAppend(state.messages, {
              kind: 'text',
              id: event.messageId,
              turnId,
              role: 'assistant',
              text: '',
              streaming: true,
            }),
          }
        case 'interjection':
          return {
            messages: replaceOrAppend(state.messages, {
              kind: 'text',
              id: event.messageId,
              turnId,
              role: 'user',
              text: event.text,
              streaming: false,
            }),
          }
        case 'textDelta':
          return {
            messages: state.messages.map((one) =>
              one.kind === 'text' && one.id === event.messageId
                ? { ...one, text: one.text + event.delta }
                : one,
            ),
          }
        case 'toolStart':
          return {
            messages: replaceOrAppend(state.messages, {
              kind: 'tool',
              id: event.messageId,
              turnId,
              toolCallId: event.toolCallId,
              title: event.title,
              status: 'running',
            }),
          }
        case 'toolProgress':
          return {
            messages: state.messages.map((one) =>
              one.kind === 'tool' && one.id === event.messageId
                ? { ...one, stage: event.stage }
                : one,
            ),
          }
        case 'clarification':
          return {
            messages: replaceOrAppend(
              state.messages,
              clarificationCard(event, event.messageId, turnId),
            ),
          }
        case 'toolEnd':
          return {
            messages: replaceOrAppend(
              state.messages,
              toolCard({ ...event, type: 'toolResult' }, event.messageId, turnId),
            ),
          }
        case 'turnEnd': {
          const turns = mergeTurn(state.turns, event.turnId, {
            durationMs: event.durationMs,
            stopReason: event.stopReason,
            ...(event.cost ? { cost: event.cost } : {}),
          })
          if (event.stopReason === 'failed') return { ...failPatch(state), turns }
          return {
            turn: 'idle' as const,
            activeTurn: null,
            turns,
            messages: state.messages.map((one) =>
              one.kind === 'text' && one.streaming ? { ...one, streaming: false } : one,
            ),
          }
        }
      }
    })
    if (event.type === 'toolEnd' && event.status === 'succeeded') {
      const artifacts = event.artifacts ?? []
      const messageId = event.messageId
      const anchor = event.anchorObjectId
      landing = landing.then(() => land(artifacts, messageId, anchor))
    }
  }

  const fail = (message?: string) => set((state) => failPatch(state, message))

  /** 跟一轮到底：流断了就带断点重连，直到读到终帧或者一直接不上。 */
  const follow = async (
    conversationId: string,
    frames: AsyncGenerator<AgentFrame>,
    pendingUserText: string | null,
    resumedTurnId = '',
  ) => {
    let source = frames
    let seen = 0
    // 只有 turnStart 带轮 id；续播接在半截上时它已经播过了，所以从调用方拿。
    let turnId = resumedTurnId
    // 重连预算按「多久没有进展」算：长轮里断上几次但每次都续上，不该被判失败。
    for (let attempt = 0; ; attempt += 1) {
      try {
        for await (const frame of source) {
          if (frame.id !== null && frame.id <= seen) continue
          if (frame.id !== null) {
            seen = frame.id
            attempt = -1
          }
          if (frame.event.type === 'turnStart') turnId = frame.event.turnId
          apply(frame.event, pendingUserText, turnId)
          if (frame.event.type === 'turnEnd') {
            await landing
            return
          }
        }
      } catch (thrown) {
        // 轮已经不在了，再重连也接不上；其余的断流与请求失败都走重连。
        if (thrown instanceof AgentRequestError && thrown.status === 404) break
        if (thrown instanceof AgentRequestError && thrown.status === 429) {
          fail(TURN_RATE_LIMITED)
          return
        }
      }
      const active = get().activeTurn
      const delay = RECONNECT_DELAYS_MS[Math.max(attempt, 0)]
      if (!active || delay === undefined) break
      await sleep(delay)
      source = resumeTurn(conversationId, active.turnId, seen)
    }
    if (get().turn === 'running') fail()
  }

  return {
    open: true,
    tab: 'chat',
    conversationId: null,
    conversations: [],
    messages: [],
    turns: {},
    turn: 'idle',
    activeTurn: null,
    error: null,
    loaded: false,
    expanded: {},

    setOpen: (open) => set({ open }),
    setTab: (tab) => set({ tab }),
    toggleExpanded: (messageId) =>
      set((state) => ({
        expanded: { ...state.expanded, [messageId]: !state.expanded[messageId] },
      })),

    async load() {
      if (get().loaded) return
      set({ loaded: true })
      const conversationId = safeLocalStorage.getItem(conversationKey())
      await Promise.all([
        get().refreshConversations(),
        ...(conversationId ? [get().selectConversation(conversationId)] : []),
      ])
    },

    async refreshConversations() {
      try {
        set({ conversations: await fetchConversations() })
      } catch {
        // 列表读不回来不该拖垮面板，留着上一份。
      }
    },

    async selectConversation(conversationId) {
      if (get().turn === 'running') return
      safeLocalStorage.setItem(conversationKey(), conversationId)
      set({ conversationId, messages: [], turns: {}, error: null })
      let state: Awaited<ReturnType<typeof fetchMessages>>
      try {
        state = await fetchMessages(conversationId)
      } catch {
        // 会话被删或换了身份：忘掉它，下一条消息开新会话。
        get().startNewConversation()
        return
      }
      set({
        messages: state.messages.map(panelMessage),
        turns: Object.fromEntries(state.turns.map((one) => [one.turnId, one])),
      })
      if (!state.activeTurn) return
      set({ turn: 'running', error: null, activeTurn: state.activeTurn })
      takeBaseRevision()
      await follow(
        conversationId,
        resumeTurn(conversationId, state.activeTurn.turnId, 0),
        null,
        state.activeTurn.turnId,
      )
    },

    async deleteConversation(conversationId) {
      try {
        await removeConversation(conversationId)
      } catch {
        return
      }
      set((state) => ({
        conversations: state.conversations.filter((one) => one.id !== conversationId),
      }))
      if (get().conversationId === conversationId) get().startNewConversation()
    },

    startNewConversation() {
      safeLocalStorage.removeItem(conversationKey())
      set({ conversationId: null, messages: [], turns: {}, error: null })
    },

    async send(text, references = []) {
      const trimmed = text.trim()
      if (!trimmed) return

      const active = get().activeTurn
      const conversationId = get().conversationId
      if (get().turn === 'running' && active && conversationId) {
        await interjectTurn(conversationId, active.turnId, trimmed)
        return
      }

      // 首轮才会定标题、才会有新会话进列表；之后每轮再拉一次是白拉。
      const firstTurn = get().messages.length === 0
      set({ turn: 'running', error: null, activeTurn: null })
      takeBaseRevision()
      let target = conversationId
      try {
        if (!target) {
          target = (await createConversation()).id
          safeLocalStorage.setItem(conversationKey(), target)
          set({ conversationId: target })
        }
      } catch {
        fail()
        return
      }
      await follow(target, startTurn(target, trimmed, references), trimmed)
      if (firstTurn) await get().refreshConversations()
    },

    async abort() {
      const active = get().activeTurn
      const conversationId = get().conversationId
      if (!active || !conversationId) return
      await abortTurn(conversationId, active.turnId)
    },

    async placeOnCanvas(messageId) {
      const message = get().messages.find((one) => one.id === messageId)
      if (message?.kind !== 'tool') return
      // 不带基线：用户点了这个按钮，写入就是他要的。
      const outcome = await writeToCanvas(message.artifacts ?? [], {
        ...(message.anchorObjectId ? { anchorObjectId: message.anchorObjectId } : {}),
      })
      if (outcome !== 'failed') setConflict(messageId, false)
    },
  }
})
