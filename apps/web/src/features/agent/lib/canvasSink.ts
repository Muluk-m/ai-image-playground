/** 智能体产出落画布的出口。创作模式挂载时把实现塞进来。 */
export interface AgentPlacedArtifact {
  readonly artifactId: string
  /** 落到画布上的位图；视频产物给的是封面。 */
  readonly dataUrl: string
  /** 视频产物的播放来源。mp4 不进画布存档，播放时现拼地址。 */
  readonly video?: { readonly taskId: string; readonly outputIndex: number }
}

export type AgentPlaceOutcome = 'placed' | 'conflict' | 'unavailable'

export interface AgentPlaceOptions {
  /**
   * 画布修订号门槛：与当前对不上就一张都不写。智能体交付不再传它——产物落的是起跑时
   * 占好的位，不会盖到用户的东西；留着给需要「画布没动过才写」的调用方。
   */
  readonly baseRevision?: number
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

/** 工具起跑时要在画布上占的位。 */
export interface AgentReservation {
  /** 这次调用会出几件产物，就占几个框。 */
  readonly count: number
  /** 贴着这个对象占；它不在画布上就从视口中央找空位。 */
  readonly anchorObjectId?: string
}

export interface AgentCanvasSink {
  /** 场景恢复完成；同步画布不需要等待。观察历史产物也必须等这个边界。 */
  readonly ready?: Promise<unknown>
  has(objectId: string): boolean
  /** 用户编辑的修订号，画布冲突判据的取值。 */
  revision(): number
  /**
   * 画布对象的 id 就是 `artifactId`。写入的唯一入口，画布冲突也判在这里。
   * 源对象一个像素不动，产出只是新增。
   */
  place(
    artifacts: readonly AgentPlacedArtifact[],
    options?: AgentPlaceOptions,
  ): Promise<AgentPlaceOutcome>
  /**
   * 工具起跑就占位：建 `count` 个互不重叠、也不压住已有元素的 loading 占位框，
   * 并把镜头带到它们所在的区域，返回它们的 id。画布还在恢复场景时会先等它。
   */
  reserve(request: AgentReservation): Promise<readonly string[]>
  /** 收掉没用上的占位框（轮中止、画布冲突、产物比预占少）。 */
  discard(placeholderIds: readonly string[]): void
  /** 工具失败：占位框转错误态留在原地，告诉用户这里本来要出一张图。 */
  markFailed(placeholderIds: readonly string[], message: string): void
  /** 选中这些对象并把镜头带过去；不在画布上的跳过。 */
  focus(objectIds: readonly string[]): void
  /** 画布是位图的单源，对象被删掉就没有缩略图了。 */
  thumbnail(objectId: string): Promise<string | null>
}

let sink: AgentCanvasSink | null = null

export function setAgentCanvasSink(next: AgentCanvasSink | null): void {
  sink = next
}

export function agentCanvasSink(): AgentCanvasSink | null {
  return sink
}
