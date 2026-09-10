/**
 * 智能体产出落画布的出口。创作模式挂载时把实现塞进来，面板与 store 只认这个接口，
 * 于是喂脚本化事件的测试不必起 Konva。
 */
export interface AgentPlacedImage {
  readonly imageId: string
  readonly dataUrl: string
}

export interface AgentCanvasSink {
  /** 画布上已经有这个对象；续播重放同一条事件时据此不重复落图。 */
  has(imageId: string): boolean
  /** 放上画布，画布对象的 id 就是 `imageId`。 */
  place(images: readonly AgentPlacedImage[]): Promise<void>
  /** 选中并把镜头带到这个对象。 */
  focus(imageId: string): void
  /** 结果卡的缩略图。画布是位图的单源，对象被删掉就没有缩略图了。 */
  thumbnail(imageId: string): Promise<string | null>
}

let sink: AgentCanvasSink | null = null

export function setAgentCanvasSink(next: AgentCanvasSink | null): void {
  sink = next
}

export function agentCanvasSink(): AgentCanvasSink | null {
  return sink
}
