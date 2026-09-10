/** 智能体产出落画布的出口。创作模式挂载时把实现塞进来。 */
export interface AgentPlacedImage {
  readonly imageId: string
  readonly dataUrl: string
}

export type AgentPlaceOutcome = 'placed' | 'conflict'

export interface AgentPlaceOptions {
  /** 跟上这一轮时的画布修订号；与当前对不上就一张都不写。省略即无条件写入（用户手动放入）。 */
  readonly baseRevision?: number
  /** 贴着这个对象放；它不在画布上就落在视口中央。 */
  readonly anchorImageId?: string
}

export interface AgentCanvasSink {
  has(imageId: string): boolean
  /** 用户编辑的修订号，画布冲突判据的取值。 */
  revision(): number
  /**
   * 画布对象的 id 就是 `imageId`。写入的唯一入口，画布冲突也判在这里。
   * 源对象一个像素不动，产出只是新增。
   */
  place(
    images: readonly AgentPlacedImage[],
    options?: AgentPlaceOptions,
  ): Promise<AgentPlaceOutcome>
  focus(imageId: string): void
  /** 画布是位图的单源，对象被删掉就没有缩略图了。 */
  thumbnail(imageId: string): Promise<string | null>
}

let sink: AgentCanvasSink | null = null

export function setAgentCanvasSink(next: AgentCanvasSink | null): void {
  sink = next
}

export function agentCanvasSink(): AgentCanvasSink | null {
  return sink
}
