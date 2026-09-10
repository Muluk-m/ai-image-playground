/** 智能体产出落画布的出口。创作模式挂载时把实现塞进来。 */
export interface AgentPlacedImage {
  readonly imageId: string
  readonly dataUrl: string
}

export interface AgentCanvasSink {
  has(imageId: string): boolean
  /** 画布对象的 id 就是 `imageId`。 */
  place(images: readonly AgentPlacedImage[]): Promise<void>
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
