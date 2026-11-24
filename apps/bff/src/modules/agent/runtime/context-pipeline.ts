import type { Api, Context, ImageContent, Model } from '@earendil-works/pi-ai'
import { compactionSettings } from '../../../lib/agent/compaction-settings'
import {
  AgentContextOverflow,
  assertRequestWithinBudget,
  requestOverheadTokens,
} from '../../../lib/agent/request-budget'
import { log } from '../../../lib/logger'
import type { AgentImageSource, VisualWorkset } from '../contracts'
import { requireAgentImages, shownImageRequests } from '../conversation'
import { type CompactionTransformInput, createCompactionTransform } from './compaction-transform'
import { omittedReviewNote, prepareReviewImages } from './review-images'
import type { PreparedAgentTurn, TurnModelHistorySaveInput, TurnRuntimePorts } from './turn-types'
import { createVisualWorkset } from './visual-workset'

export { createVisualWorkset }

type TurnMessages = TurnModelHistorySaveInput['messages']
type TurnInitialMessages = ReturnType<
  TurnRuntimePorts['turnInput']['turnInitialStateOf']
>['messages']
type TurnTools = ReturnType<TurnRuntimePorts['tools']['agentTurnTools']>

export interface TurnContextPipeline {
  readonly initialState: {
    readonly systemPrompt: string
    readonly messages: TurnInitialMessages
  }
  readonly visualWorkset: VisualWorkset
  transformContext(messages: TurnInitialMessages): Promise<TurnInitialMessages>
  assertWithinBudget(context: Context, onOverflow: (thrown: AgentContextOverflow) => void): void
  prepareInitialPrompt(
    images: AgentImageSource,
  ): Promise<{ readonly text: string; readonly content: ImageContent[] }>
  saveHistoryAfterTurn(input: {
    readonly outcome: TurnModelHistorySaveInput['outcome']
    readonly steered: boolean
    readonly storedMessages: TurnModelHistorySaveInput['expectedHistory']
    readonly messages: TurnMessages
  }): Promise<void>
}

/**
 * 上下文塑形管道（压缩 + 原生模型历史缓存 + 出站预算硬闸 + 视觉工作集 + 轮后历史持久化）。
 */
export function createTurnContextPipeline(input: {
  readonly prepared: PreparedAgentTurn
  readonly ports: TurnRuntimePorts
  readonly model: Model<Api>
  readonly turnTools: TurnTools
  readonly visualWorkset: VisualWorkset
  readonly onSummaryAttempt: NonNullable<CompactionTransformInput['onSummaryAttempt']>
}): TurnContextPipeline {
  const { prepared, ports, model, turnTools, visualWorkset, onSummaryAttempt } = input
  const { conversationId, turnId, userMessageId, execution } = prepared
  const { audience, history, mode } = prepared.input

  const initialState = ports.turnInput.turnInitialStateOf(prepared.input)
  const budget = compactionSettings(model)
  // 系统说明与工具清单这一轮里逐字不变，算一次就够；塑形按它让预算，硬闸按真发出去的那一份判。
  const overheadTokens = requestOverheadTokens({
    systemPrompt: initialState.systemPrompt,
    tools: turnTools,
  })
  const compact = createCompactionTransform({
    conversationId,
    turnId,
    historyIds: history.messages.map((message) => message.id),
    userMessageId,
    compaction: history.compaction,
    foldedBefore: history.coveredCount,
    overheadTokens,
    settings: budget,
    onSummaryAttempt,
  })
  const retained = prepared.input.modelHistory
    ? ports.history.modelHistoryTransform({
        signature: prepared.input.modelHistory.signature,
        nativePrefixLength: initialState.messages.length,
        replay: () =>
          ports.turnInput.turnInitialStateOf({ ...prepared.input, modelHistory: undefined })
            .messages,
        settings: budget,
        overheadTokens,
        compact,
      })
    : undefined

  return {
    initialState,
    visualWorkset,
    transformContext: (messages) =>
      visualWorkset.transform(messages, retained?.transform ?? compact),
    assertWithinBudget(context, onOverflow) {
      // 最后一道闸：算出来就超限的请求不发。上游那边它是一个更贵、更慢、必然被拒的请求，
      // 而这一刻退回去发更完整的历史只会更超（见 `request-budget.ts`）。
      // pi 的契约是 streamFn 的失败要编进返回流里，所以它把这一抛翻成「上游出错」的终帧；
      // 原因在这里先记下，那一段才不会把「没发出去」说成「上游挂了」。
      try {
        assertRequestWithinBudget(context, budget)
      } catch (thrown) {
        if (thrown instanceof AgentContextOverflow) {
          // 两件事要分开：本轮内容太大，用户减字减图就能自救；固定开销自己就吃光了上限，
          // 那是部署把窗口配小了，用户删什么都没用，每一轮都会被拒——那条要吵醒运营。
          const misconfigured = overheadTokens >= thrown.limit
          const entry = {
            event: 'agent.context_overflow',
            conversationId,
            turnId,
            inputTokens: thrown.inputTokens,
            overheadTokens,
            limit: thrown.limit,
          }
          if (misconfigured) {
            log.error(
              entry,
              'agent system prompt and tools alone exceed the input budget; raise the configured context window',
            )
          } else {
            log.warn(entry, 'agent request exceeded the input budget and was not sent')
          }
          onOverflow(thrown)
        }
        throw thrown
      }
    },
    async prepareInitialPrompt(images) {
      const references = await requireAgentImages(
        images,
        shownImageRequests(ports.turnInput.requestAgentReferences(prepared.input)),
      )
      // 复核用预览而不是原件：4K 产物的原件会把整轮请求撑过字节预算。装不下的如实告诉模型。
      const { reviewed, omitted } = await prepareReviewImages(
        images,
        references,
        prepared.input.reviewImageIds,
        prepared.input.optionalReviewImageIds,
      )
      const reviewSet = new Set(reviewed)
      const evidence = await ports.turnInput.turnVisualEvidence(
        [...references, ...reviewed],
        (image) => (reviewSet.has(image) ? 'result-review' : 'initial'),
      )
      // 正文与预扣估算读的是同一份轮输入（`turnPromptBody`）：`/skill-name` 的展开范围、
      // 引用清单与并进来的唤醒说明的位置，两条路因此只有一种拼法。
      return ports.turnInput.turnModelPrompt(
        ports.turnInput.turnPromptBody(prepared.input, images.references) +
          omittedReviewNote(omitted),
        evidence,
      )
    },
    async saveHistoryAfterTurn({ outcome, steered, storedMessages, messages }) {
      await ports.history.saveModelHistoryAfterTurn({
        outcome,
        retained,
        userMessageStored: !!prepared.storedUserMessage,
        steered,
        conversationId,
        turnId,
        owner: prepared.owner,
        mode,
        userId: prepared.userId,
        experience: audience.experience,
        expectedHistory: [...history.messages, ...storedMessages],
        previousSkills: prepared.input.skillTexts,
        messages,
        assertExecution: execution.assert,
      })
    },
  }
}
