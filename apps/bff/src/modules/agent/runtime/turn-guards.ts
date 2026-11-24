import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createAutoSubmitBudget } from '../../../lib/agent/auto-submit'
import { wholeImageEditIntent } from '../../../lib/agent/edit-intent'
import { createImageCombinationGuard } from '../../../lib/agent/image-combinations'
import { createAgentToolGate } from '../../../lib/agent/tool-gate'
import type { ChatAttempt } from '../../../lib/chatCompletion'
import {
  type AgentImageSource,
  createMaskedEditPlan,
  createToolFailureLog,
  type ImageCombinationGuard,
  type MaskedEditPlan,
  type ToolFailureLog,
  type TurnAuthorization,
  type VisualWorkset,
} from '../contracts'
import { createAgentImageSource } from '../conversation'
import type { PreparedAgentTurn, TurnRuntimePorts } from './turn-types'

export interface TurnGuards {
  readonly images: AgentImageSource
  readonly authorization: TurnAuthorization
  readonly maskedEditPlan: MaskedEditPlan
  readonly imageCombinations: ImageCombinationGuard
  readonly gate: ReturnType<typeof createAgentToolGate>
  readonly toolFailures: ToolFailureLog
  readonly turnTools: AgentTool[]
}

/** 装配单轮全部业务守卫与工具上下文（图片源、授权原文、遮罩计划、组合澄清、确认门与工具清单）。 */
export function createTurnGuards(input: {
  readonly prepared: PreparedAgentTurn
  readonly ports: TurnRuntimePorts
  readonly visualWorkset: VisualWorkset
  readonly recordWebSearch: (attempt: ChatAttempt) => Promise<void>
}): TurnGuards {
  const { prepared, ports, visualWorkset, recordWebSearch } = input
  const { conversationId, turnId, execution } = prepared
  const { audience, history, mode, selectionHistoryStart } = prepared.input

  const images = createAgentImageSource({
    references: prepared.input.references,
    history: history.messages,
    conversationId,
    userId: prepared.userId,
    canvasMediaIds: prepared.canvas?.elements.flatMap((element) =>
      element.type === 'image' && element.mediaId ? [element.mediaId] : [],
    ),
    selectionHistoryStart,
  })
  const requestRefs = ports.turnInput.requestAgentReferences(prepared.input)
  const authorization = ports.turnInput.createTurnAuthorization({
    history: history.messages,
    prompt: prepared.wake?.authorizationPrompt ?? prepared.input.text,
    references: images.references,
    attached: requestRefs.length > 0,
    ...(prepared.wake?.plan ? { carried: prepared.wake.plan.authorization } : {}),
  })
  const maskedEditPlan = createMaskedEditPlan(
    () => authorization.current().instructions,
    images.identify,
    images.masked,
    prepared.wake?.plan,
  )
  const imageCombinations = createImageCombinationGuard({
    history: history.messages,
    references: requestRefs,
    text: prepared.input.text,
    hasNewReferences: prepared.input.references.length > 0,
  })
  const toolFailures = createToolFailureLog()
  // 唤醒轮的 text 是系统说明，不是用户的话；澄清作答连同它答的那句原话一起看。
  const userAsk = [
    ...history.messages
      .slice(ports.turnInput.clarificationChainStart(history.messages))
      .flatMap((message) =>
        message.role === 'user'
          ? message.content.flatMap((block) => (block.type === 'text' ? [block.text] : []))
          : [],
      ),
    prepared.input.text,
  ].join('\n')
  // 智能体模式关掉了直接出图：生成调用由确认门拦下，智能体不知道（见 `tool-gate.ts`）。
  const gate = createAgentToolGate(prepared.input.toolGate === true)
  const turnTools = ports.tools.agentTurnTools(
    {
      mode,
      experience: audience.experience,
      conversationId,
      turnId,
      userId: prepared.userId,
      deviceId: prepared.deviceId,
      images,
      visualWorkset,
      imageCombinations,
      maskProposals: new Set<string>(),
      ...(!prepared.wake && wholeImageEditIntent(userAsk)
        ? { wholeImageEdit: { nudged: false } }
        : {}),
      authorization: () => authorization.current(),
      maskedEditPlan,
      assertExecution: execution.assert,
      recordWebSearch,
      ...(prepared.params ? { params: prepared.params } : {}),
      // 画布快照只交给画布模式的工具；Agent 模式这一轮不感知画布。
      ...(prepared.canvas && audience.experience === 'canvas' ? { canvas: prepared.canvas } : {}),
      // Canvas has one authorization mechanism; per-turn image quota is chat-only.
      ...(prepared.input.autoSubmit && audience.experience !== 'canvas'
        ? { autoSubmit: createAutoSubmitBudget() }
        : {}),
      ...(prepared.wake?.replay ? { replay: prepared.wake.replay } : {}),
      ...(prepared.input.toolGate ? { gate: gate.view } : {}),
    },
    toolFailures,
  )
  return {
    images,
    authorization,
    maskedEditPlan,
    imageCombinations,
    gate,
    toolFailures,
    turnTools,
  }
}
