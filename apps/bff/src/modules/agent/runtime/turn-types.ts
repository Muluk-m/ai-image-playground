import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core'
import type { Api, AssistantMessageEventStream, ImageContent, Model } from '@earendil-works/pi-ai'
import type {
  AgentCanvasSnapshot,
  AgentClarificationBlock,
  AgentMessageView,
  AgentMode,
  AgentStoredReference,
  AgentToolErrorCode,
  AgentToolName,
  AgentTurnCost,
  AgentTurnErrorCode,
  AgentTurnFailure,
  AgentTurnParams,
  AgentTurnReference,
  AgentTurnUsage,
  ReplyScriptGate,
} from '@image-playground/shared'
import type { CompactionSettings } from '../../../lib/agent/compaction'
import type { ConfiguredAgentRuntime } from '../../../lib/agent/provider-settings'
import type { ShortConfirmationGuard } from '../../../lib/agent/short-confirmation'
import type { AgentTurnInput, TurnVisualEvidence } from '../../../lib/agent/turn-input'
import type { TaskOutcome } from '../../../lib/private-overlay'
import type {
  AgentContextTransform,
  AgentImageReference,
  AgentImageSource,
  AgentSubmissionReplay,
  AgentToolContext,
  AgentToolOutcome,
  AgentToolStart,
  MaskedPlanCarry,
  ResolvedAgentImage,
  ToolFailureLog,
  TurnAuthorization,
} from '../contracts'
import type { AgentOwner, TurnExecution } from '../conversation'

export interface AgentTurnSettlement {
  readonly outcome: TaskOutcome
  readonly usage: AgentTurnUsage | null
  readonly upstreamInvocationCount: number
}

/**
 * 准备好的一轮：起轮准备（`turn-preparation.ts`）交出来的全部东西，`startAgentTurn` 只认它。
 * 用户消息、唤醒与中断续跑三种来源的差别都已经在准备那一步折平。
 */
export interface PreparedAgentTurn {
  readonly selectedRuntime?: ConfiguredAgentRuntime
  /** 这一轮对会话的执行权：写库之前确认，落库在它的事务里。 */
  readonly execution: TurnExecution
  readonly conversationId: string
  /** 起轮准备已经确权的会话归属；轮后重读历史照它读。 */
  readonly owner: AgentOwner
  readonly turnId: string
  readonly userMessageId: string
  readonly storedUserMessage?: AgentMessageView
  /** 这一轮取走的排队消息；缺席即这一句是当场发来的，没排过队。 */
  readonly queueId?: string
  /** 送给模型的那一份输入；起轮前的预扣就是照它估的（见 `turn-input.ts`）。 */
  readonly input: AgentTurnInput
  /** 工具提交的图片任务归到这个身份下，计费与配额因此与用户自己提交的一致。 */
  readonly userId: string | null
  readonly deviceId: string
  /** 用户在输入框的参数浮层里选的生成参数；缺席即全部按部署默认。 */
  readonly params?: AgentTurnParams
  /** 发话时浏览器里的画布。 */
  readonly canvas?: AgentCanvasSnapshot
  /**
   * 唤醒轮与中断续跑：`input.text` 是给模型的系统说明，不是用户的话，也不落库。授权原文与改图
   * 计划接着提交那一批的那一轮（`plan`，它记着当时的授权原文）；没有记下计划时退回
   * `authorizationPrompt`（提交那一轮用户的原话）。要复核的产物在 `input.reviewImageIds`。
   */
  readonly wake?: {
    readonly authorizationPrompt: string
    readonly plan?: MaskedPlanCarry
    /** 中断续跑才有：被打断那一轮已经提交的任务，同样的调用再来一次时交回它们（见 `interrupted.ts`）。 */
    readonly replay?: AgentSubmissionReplay
  }
  /** 起轮时预扣的积分；缺席即这个部署不计费。 */
  readonly reservedCredits?: number
  /**
   * 用户只发了短确认语，且会话里有待确认卡片或已经出完/还在跑的批次：
   * 这一轮不再问模型，直接回复，生成类工具因此不会被调用。
   */
  readonly confirmationGuard?: ShortConfirmationGuard
  /** 收尾结算，回报本轮结算后的消耗；缺席即这个部署不计费。 */
  readonly settle?: (settlement: AgentTurnSettlement) => Promise<AgentTurnCost>
}

export interface RetainedModelHistoryController {
  readonly signature: string
  reusable(): boolean
  transform(
    messages: AgentMessage[],
    accepts?: (messages: readonly AgentMessage[]) => boolean,
  ): Promise<AgentMessage[]>
}

export interface TurnToolRuntime {
  agentTurnTools(context: AgentToolContext, failures?: ToolFailureLog): AgentTool[]
  agentToolStart(
    mode: AgentMode,
    toolName: AgentToolName,
    toolCallId: string,
    args: unknown,
    images: AgentImageSource,
    params?: AgentTurnParams,
  ): AgentToolStart
  agentToolEnd(
    start: AgentToolStart,
    result: unknown,
    failure: AgentToolErrorCode | null,
  ): AgentToolOutcome
  isAgentToolName(name: string): name is AgentToolName
}

export interface TurnModelHistorySaveInput {
  readonly outcome: TaskOutcome
  readonly retained?: { readonly signature: string; reusable(): boolean }
  readonly userMessageStored: boolean
  readonly steered: boolean
  readonly conversationId: string
  readonly turnId: string
  readonly owner: AgentOwner
  readonly mode: AgentMode
  readonly userId: string | null
  readonly experience?: 'chat' | 'canvas'
  readonly expectedHistory: readonly AgentMessageView[]
  readonly previousSkills?: ReadonlyMap<string, string>
  readonly messages: readonly AgentMessage[]
  readonly assertExecution: () => Promise<void>
}

export interface TurnHistoryPort {
  modelHistoryTransform(input: {
    readonly signature: string
    readonly nativePrefixLength: number
    readonly replay: () => AgentMessage[]
    readonly settings: CompactionSettings
    readonly overheadTokens: number
    readonly compact: AgentContextTransform
  }): RetainedModelHistoryController
  saveModelHistoryAfterTurn(save: TurnModelHistorySaveInput): Promise<void>
}

export interface TurnInputPort {
  createTurnAuthorization(input: {
    readonly history: readonly AgentMessageView[]
    readonly prompt: string
    readonly references: readonly AgentImageReference[]
    readonly attached: boolean
    readonly carried?: string
  }): TurnAuthorization
  clarificationChainStart(history: readonly AgentMessageView[]): number
  expandSkillInvocation(
    text: string,
    mode: AgentMode,
    audience?: AgentTurnInput['audience'],
  ): string
  requestAgentReferences(
    input: Pick<AgentTurnInput, 'references' | 'history'>,
  ): readonly AgentImageReference[]
  turnInitialStateOf(input: AgentTurnInput): {
    readonly systemPrompt: string
    readonly messages: AgentMessage[]
  }
  turnModelPrompt(
    promptText: string,
    evidence: TurnVisualEvidence,
  ): { readonly text: string; readonly content: ImageContent[] }
  turnPromptBody(input: AgentTurnInput, references?: readonly AgentImageReference[]): string
  turnPromptText(
    text: string,
    references: readonly AgentImageReference[],
    selected: boolean,
  ): string
  turnVisualEvidence(
    images: readonly ResolvedAgentImage[],
    source?: string | ((image: ResolvedAgentImage) => string),
  ): Promise<TurnVisualEvidence>
}

export interface TurnDirectEditPort {
  readonly CONFIRMED_EDIT_CALL_PREFIX: string
  directImageCall(
    input: Pick<
      AgentTurnInput,
      'directImage' | 'mode' | 'audience' | 'text' | 'references' | 'history' | 'continuation'
    >,
    wake: boolean,
  ): Record<string, unknown> | null
  confirmedMaskEditCall(
    history: readonly AgentMessageView[],
    references: readonly AgentTurnReference[],
    images: Pick<AgentImageSource, 'resolve'>,
  ): Promise<Record<string, unknown> | null>
  toolCallStream(
    model: Pick<Model<Api>, 'api' | 'provider' | 'id'>,
    name: string,
    args: Record<string, unknown>,
  ): AssistantMessageEventStream
}

export interface TurnMaskProposalPort {
  readonly AGENT_MASK_PROPOSAL_TOOL: string
  maskProposalFromResult(result: unknown): AgentClarificationBlock | null
  maskProposalGuidance(errorText: string): boolean
  maskProposalRetryable(errorText: string): boolean
  maskProposalFailedText(errorText: string): string
}

/** 运行层执行单轮所需的窄端口集合：将高层工具注册表、遮罩提案与历史拼装从 `runtime/` 反转出去。 */
export interface TurnRuntimePorts {
  readonly tools: TurnToolRuntime
  readonly history: TurnHistoryPort
  readonly turnInput: TurnInputPort
  readonly directEdit: TurnDirectEditPort
  readonly maskProposal: TurnMaskProposalPort
}

export interface OpenAssistantMessage {
  readonly id: string
  text: string
  persisted?: boolean
  /** 这一条助手正文的文字清洗。增量只往外追加，收尾时才可能补上兜底句。 */
  readonly script: ReplyScriptGate
  started: boolean
}

export interface OpenToolCall {
  readonly messageId: string
  /** 起跑那一刻工具的自述；结果卡照它出，中途不再重算。 */
  readonly start: AgentToolStart
}

export interface SteeringReferenceEntry {
  readonly references: readonly AgentTurnReference[]
  readonly text: string
  /** 插话那一刻本轮认的引用；授权原文的清单按它拼。 */
  readonly active: readonly AgentImageReference[]
}

export interface QueuedInterjection {
  readonly id: string
  readonly text: string
  readonly references: readonly AgentStoredReference[]
}

/** 单轮运行期间跨事件循环、流控与收尾共享的可变状态。 */
export interface TurnExecutionState {
  clarified: boolean
  confirmationGuarded: boolean
  directEditTried: boolean
  directEditSubmitted: boolean
  combinationClarified: boolean
  /** 这一轮已经拟出待确认的稿：接下来该说话的是用户，再问一次模型只是白花钱。 */
  drafted: boolean
  failure: AgentTurnFailure | undefined
  error: AgentTurnErrorCode | undefined
  aborted: boolean
  /** 只有用户点「中止」才连带取消本轮任务；租约丢失等中止不能把还在正常跑的出图当退款处理。 */
  userStopped: boolean
  /** 本轮已经为长度截断续写过一次。再截断就失败，避免无限续。 */
  lengthContinuations: number
  /** 截断消息里的工具参数不完整，那些 start/end 不能变成用户看得见的工具卡。 */
  ignoringTruncatedTools: boolean
  /** 这一轮已经成功写入计划的项数，失败文案用它告诉用户续写从哪接着。 */
  savedPlanItems: number
  /** 终帧发过没有。收尾半路抛错时据此补一个，续播的消费者不能一直等下去。 */
  ended: boolean
  acceptingInterjections: boolean
  maskProposalRetried: boolean
}
