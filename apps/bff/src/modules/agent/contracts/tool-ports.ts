import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { ImageContent, Message } from '@earendil-works/pi-ai'
import type {
  AgentClarificationBlock,
  AgentImageEditAction,
  AgentMarkedRegion,
  AgentMediaReference,
  AgentStoredReference,
  AgentToolArtifact,
  AgentTurnReference,
  AgentVisualEvidence,
  AgentVisualObservation,
} from '@image-playground/shared'

export type AgentContextTransform = (
  messages: AgentMessage[],
  accepts?: (messages: readonly AgentMessage[]) => boolean,
) => Promise<AgentMessage[]>

/** 一轮里还能自动提交几次。额度是这一轮唯一的刹车。 */
export interface AgentAutoSubmitBudget {
  /** 领一次额度：`true` 才自动提交，`false` 表示这一轮领完了，调用方退回拟稿。 */
  take(): boolean
}

export type AgentImageReference = AgentTurnReference | AgentStoredReference

/**
 * 要原件还是要预览。画布媒体两份都存着（`object_key` / `preview_key`），看一眼判断「这是不是
 * 那张图」用预览就够，而原件一次就是几 MB 的 data URL——全都按原件发，长会话必然先撞出站硬闸。
 * 其余来源（本轮附图、工具产物、素材）只有一份字节，`preview` 对它们无意义，照常给原件。
 */
export type AgentImageVariant = 'original' | 'preview'

/**
 * 取图时可要的形态：除两种变体外，`edit` 是送进改图的原件——超大图先等比缩到最长边 4000
 * 再送（BUG-35）；带遮罩的仍原样，遮罩绑着原图像素。
 */
export type AgentImageRead = AgentImageVariant | 'edit'

export interface ResolvedAgentImage {
  readonly imageId: string
  readonly dataUrl: string
  readonly visualVariant?: AgentImageVariant | 'region'
  /** 本轮附图或系统续作计划中的遮罩；普通历史引用只有原图。 */
  readonly maskDataUrl?: string
  readonly editAction?: AgentImageEditAction
  readonly regions?: readonly AgentMarkedRegion[]
}

/** 模型只会说图片 id，字节从哪来由这里决定。 */
export interface AgentImageSource {
  readonly references: readonly AgentImageReference[]
  /**
   * 当前请求作用域中是否有选区：本轮附图、未完成澄清链或已授权续作。
   * 普通历史图片的选区不在作用域内，不能把之后的新请求锁在局部改图里。
   */
  readonly masked: boolean
  /**
   * 模型说的那个 id 对应的真 id（把 `image 2` 这类编号翻回去），不读字节。
   * 工具起跑时要立刻把锚点告诉画布，那一刻等不起一次对象存储往返。
   */
  attach(references: readonly AgentTurnReference[]): void
  identify(imageId: string): string
  resolve(imageId: string, variant?: AgentImageRead): Promise<ResolvedAgentImage | null>
  /** Freeze original identities without fetching pixels; null entries are not durable inputs. */
  resolveMediaReferences(
    imageIds: readonly string[],
  ): Promise<readonly (AgentMediaReference | null)[]>
  /** 记下工具刚产出的图，同一轮里下一个工具才能接着改它。视频不进这里：它取不出可编辑的位图。 */
  note(artifacts: readonly AgentToolArtifact[]): void
}

/**
 * 按 id 取图时要哪一份字节。只给 id 即原件：工具拿到的图要送进上游改，缩过的那一份不行。
 * 只有「给模型看一眼」的场合才写成带 `variant` 的形状。
 */
export type AgentImageRequest =
  | string
  | { readonly imageId: string; readonly variant: AgentImageRead }

export interface VisualWorkset {
  admit(blocks: readonly ImageContent[], removing?: ReadonlySet<ImageContent>): void
  dispatched(messages: readonly Message[]): AgentVisualEvidence[]
  release(
    completed: readonly { imageId: string; observation: string }[],
    dependencies?: readonly string[],
    replacement?: readonly ImageContent[],
  ): AgentVisualObservation[]
  transform(messages: AgentMessage[], compact: AgentContextTransform): Promise<AgentMessage[]>
}

export interface ImageCombinationGuard {
  inspect(ids: readonly string[], n?: number): AgentClarificationBlock | undefined
  submitted(ids: readonly string[]): void
  interjected(references: readonly { readonly imageId: string }[]): void
}

/** 当前版本的授权原文。对象身份就是版本身份：工具取了快照，靠 `!==` 认出原文被改过。 */
export interface TurnAuthorizationText {
  readonly revision: number
  readonly instructions: string
}

export interface TurnAuthorization {
  /** 此刻的授权原文；同一版本每次拿到的是同一个对象。 */
  current(): TurnAuthorizationText
  /** 用户插话：那句原话连同它的引用清单追加成「用户补充」，版本加一。 */
  amend(text: string, references: readonly AgentImageReference[], attached: boolean): void
}

export interface MaskedOperation {
  readonly targetImageId: string
  readonly selectionId?: string
  readonly requestQuote: string
  readonly n?: number
}

/** 一次真遮罩编辑做的是哪件事：换个 tool-call id 重来一次，批次身份认不出，内容身份认得出。 */
export interface MaskedEditContent {
  readonly imageIds: readonly string[]
  readonly selectionBindings?: readonly { readonly imageId: string; readonly selectionId: string }[]
  /** 这次操作对应的用户原文；模型没摘录时回落到工具起跑时的整段授权原文。 */
  readonly quote?: string
}

/** 要提交的这次付费操作。两个身份各自回答一个问题，缺席即那个问题不适用。 */
export interface MaskedSubmission {
  /** 本轮遮罩批次里的这次调用；缺席即这次提交不受批次约束（非遮罩轮）。 */
  readonly call?: {
    readonly toolCallId: string
    readonly operation?: MaskedOperation
  }
  /** 这次编辑的内容身份；缺席即它不是真遮罩编辑（生图、无遮罩改图）。 */
  readonly content?: MaskedEditContent
}

/** 为什么不能提交。放行之外的每一个取值对应模型该做的一件不同的事，所以不是布尔。 */
export type MaskedApproval =
  /** 可以提交。 */
  | 'approved'
  /** 这条内容本轮已经提交过，模型该去看候选而不是再付一次费。 */
  | 'already-submitted'
  /** 不在冻结的批次里，模型该停下等用户指示而不是自行追加。 */
  | 'outside-batch'

/** 助手消息里的一次工具调用，批次照它冻结。 */
export interface PlanCall {
  readonly id: string
  readonly name: string
  readonly arguments: Record<string, unknown>
}

/**
 * 计划交给唤醒轮的那一份：提交那一刻的授权原文与计划状态。唤醒轮不是用户开的，它的计划不另起，
 * 而是接着提交那一轮的走——已经付过费的内容照样不能重提，遮罩轮只剩预先列明、还没执行的后续编辑。
 */
export interface MaskedPlanCarry {
  /** 提交那一刻的授权原文；唤醒轮按它核对 requestQuote，连续几次唤醒也还是用户最初的原话。 */
  readonly authorization: string
  readonly protected: boolean
  /** 已经提交过的真遮罩编辑的内容身份。 */
  readonly contents: readonly string[]
  /** 预先列明、还没执行的后续编辑。 */
  readonly deferred: readonly string[]
}

export interface MaskedEditPlan {
  /** 本轮是不是已经进入遮罩作用域；进入后不因引用被换掉而解除。 */
  readonly protected: boolean
  protect(): void
  /** 首条带工具调用的助手消息处冻结批次；提交过任务后不再重冻。 */
  capture(batch: readonly PlanCall[]): void
  /** 「这次付费操作能不能提交」的唯一回答者。 */
  approve(submission: MaskedSubmission): MaskedApproval
  /** 任务真的建出来了才登记；失败的提交不占批次名额，也不算内容提交过。 */
  submitted(submission: MaskedSubmission): void
  interjected(): void
  /** 这次提交登记之后计划会是什么样：随任务一起记下，唤醒轮据此接着执行。 */
  carryAfter(submission: MaskedSubmission): MaskedPlanCarry
}

/** 同一批里几个任务各自记下的计划合成一份：内容取并集，后续编辑以最后提交的那一次为准。 */
export function mergeMaskedPlanCarries(
  carries: readonly MaskedPlanCarry[],
): MaskedPlanCarry | undefined {
  const last = carries.at(-1)
  if (!last) return undefined
  return {
    authorization: last.authorization,
    protected: carries.some((carry) => carry.protected),
    contents: [...new Set(carries.flatMap((carry) => carry.contents))],
    deferred: last.deferred,
  }
}
