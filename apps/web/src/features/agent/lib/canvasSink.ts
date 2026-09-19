import type {
  AgentTimelinePlan,
  AgentToolArtifact,
  AgentToolErrorCode,
  ChannelMedia,
  VideoGenerationRecord,
} from '@image-playground/shared'
/** 智能体产出落画布的出口。创作模式挂载时把实现塞进来。 */
export interface AgentPlacedArtifact {
  readonly artifactId: string
  readonly taskId?: string
  readonly name?: string
  /** 落到画布上的位图；视频产物给的是封面。 */
  readonly dataUrl: string
  /** 这次工具调用实际用的完整提示词。视频「改参数重新生成」拿它预填，标题只是摘要。 */
  readonly prompt?: string
  /** 视频产物的播放来源。mp4 不进画布存档，播放时现拼地址。 */
  readonly video?: {
    readonly taskId: string
    readonly outputIndex: number
    readonly generation?: VideoGenerationRecord
  }
}

export type AgentPlaceOutcome = 'placed' | 'unavailable'

export interface AgentPlaceOptions {
  /** 贴着这个对象放；它不在画布上就落在视口中央。 */
  readonly anchorObjectId?: string
  /** 异步准备结束后、真正写入前，交付仍属于当前会话与画布。 */
  readonly isCurrent?: () => boolean
  /**
   * 工具起跑时占下的位（`reserve` 的返回值）。产物按顺序落进它们，随后占位框消失。
   * 数量不足（续播只收到尾巴、或上游多给了几张）时余下的现找空位，不会因此丢产物。
   */
  readonly placeholderIds?: readonly string[]
}

/** 画布上一个失败占位：一键补齐据此逐个重试。 */
export interface AgentFailedPlaceholder {
  readonly id: string
  readonly errorCode?: AgentToolErrorCode
  /** 云端占位此刻挂着的那次生成（任务 id）；本机占位缺席。 */
  readonly generationId?: string
}

/** 工具起跑时要在画布上占的位。 */
export interface AgentReservation {
  readonly media?: ChannelMedia
  readonly messageId?: string
  /** 这次调用属于哪个会话；失败占位的「让助手重新处理」只能发回这个会话。 */
  readonly conversationId?: string
  readonly title?: string
  /** 这次调用会出几件产物，就占几个框。 */
  readonly count: number
  /** 贴着这个对象占；它不在画布上就从视口中央找空位。 */
  readonly anchorObjectId?: string
}

export interface AgentCanvasSink {
  /** 会话文档在视图切走后仍存活并持久化，允许原任务完成交付。 */
  background?: boolean
  /** 场景恢复完成；同步画布不需要等待。观察历史产物也必须等这个边界。 */
  readonly ready?: Promise<unknown>
  has(objectId: string): boolean
  /** 云端负责交付时只刷新项目；null 表示仍由本机交付。 */
  syncArtifacts?(artifacts: readonly AgentToolArtifact[]): Promise<AgentPlaceOutcome | null>
  /**
   * 画布对象的 id 就是 `artifactId`。写入的唯一入口。产物落的是起跑时占好的位，
   * 用户中途编辑画布不会拦下它；源对象一个像素不动，产出只是新增。
   */
  place(
    artifacts: readonly AgentPlacedArtifact[],
    options?: AgentPlaceOptions,
  ): Promise<AgentPlaceOutcome>
  /**
   * 智能体排的时间线：按计划在画布上建一条，id 用计划里的那个，重放不建第二条。
   * 计划里的视频一段都不在画布上时是 `unavailable`。缺席即这块画布不收时间线。
   */
  placeTimeline?(plan: AgentTimelinePlan): Promise<AgentPlaceOutcome>
  /**
   * 工具起跑就占位：建 `count` 个互不重叠、也不压住已有元素的 loading 占位框，
   * 并把镜头带到它们所在的区域，返回它们的 id。画布还在恢复场景时会先等它。
   */
  reserve(request: AgentReservation): Promise<readonly string[]>
  /** 收掉没用上的占位框（轮中止、画布已离开、产物比预占少）。 */
  discard(placeholderIds: readonly string[]): void
  /**
   * 工具失败：占位框转错误态留在原地，告诉用户这里本来要出一张图。带着错误码，
   * 失败占位就按码出文案与出路；没有码（旧服务端）时照旧显示 `message`。
   */
  markFailed(
    placeholderIds: readonly string[],
    message: string,
    errorCode?: AgentToolErrorCode,
  ): void
  /**
   * 单张重试：这些失败占位重新转圈，等重试的产物落进来。云端项目的失败占位由服务端在受理重试时
   * 就地换成新的预留位置，这里只需拉一次云端文档。等到占位确实换过来才兑现：在那之前旧的失败占位
   * 还挂着重试，按钮要一直按住，不然同一个占位能再提交一次。缺席即这块画布不支持重试。
   */
  revive?(placeholderIds: readonly string[]): Promise<void>
  /**
   * 一次调用留在画布上的失败占位：本机占的位认结果卡的 messageId，云端项目的认任务 id（那次调用的，
   * 以及接替过它的重试的）。缺席即这块画布不支持一键补齐。
   */
  failedPlaceholders?(ref: {
    readonly messageId: string
    readonly taskIds: readonly string[]
  }): readonly AgentFailedPlaceholder[]
  /** 选中这些对象并把镜头带过去；不在画布上的跳过。 */
  focus(objectIds: readonly string[]): void
  /**
   * 定位一个还没出结果的生成：选中它占的位并把镜头带过去。本机占的位记着结果卡的 messageId，
   * 云端项目预留的位记着任务 id。没有这样的占位就什么也不做，返回 false 让调用方另找去处。
   */
  focusPending?(ref: { readonly messageId: string; readonly taskId?: string }): boolean
  /** 画布是位图的单源，对象被删掉就没有缩略图了。 */
  thumbnail(objectId: string): Promise<string | null>
}

let sink: AgentCanvasSink | null = null
const listeners = new Set<(sink: AgentCanvasSink | null) => void>()

export function setAgentCanvasSink(next: AgentCanvasSink | null): void {
  if (sink === next) return
  sink = next
  for (const listener of listeners) listener(next)
}

/** 画布挂上 / 卸下时通知；交付层靠它把画布不在时错过的产物补落回去。 */
export function onAgentCanvasSinkChange(
  listener: (sink: AgentCanvasSink | null) => void,
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function agentCanvasSink(): AgentCanvasSink | null {
  return sink
}
