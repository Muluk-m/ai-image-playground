import type { ComponentType, ReactNode } from 'react'

/** 已经实现的工具。加一件就在这里加一个 id、写一个模块、登记进 `registry.ts`，目录页自己会长出卡片。 */
export type ToolId = 'compress'

/** 目录页的两组：单张 / 批量处理，多图合成。 */
export type ToolGroup = 'process' | 'compose'

/** 一张等着被处理的图。位图由工具箱 store 持有，工具只读它。 */
export interface ToolSource {
  id: string
  name: string
  /** 原文件的 MIME，「保持原格式」按它落点。 */
  type: string
  /** 原文件体积，卡片上的前后对比要它。 */
  size: number
  bitmap: ImageBitmap
}

export interface ToolOutput {
  blob: Blob
  /** 真实出来的格式。 */
  type: string
  width: number
  height: number
  /** 这台浏览器编不出所选格式，canvas 按规范换了别的。 */
  fellBack: boolean
}

/**
 * 一张图没处理成的原因。存的是码不是译文：切语言时已经显示的报错要跟着变。
 * `canvasLimit` 带着尺寸——用户要看见是哪个数字太大了。
 */
export type ToolFailure =
  | { code: 'canvasLimit'; width: number; height: number }
  | { code: 'undecodable' }
  | { code: 'failed' }

export interface ToolController {
  /** 工具页参数行里的控件。 */
  controls: ReactNode
  /** 绑好当前参数的处理函数；逐张跑，结果卡一张一张亮。参数变了要换一个新的函数身份。 */
  run: (source: ToolSource) => Promise<ToolOutput>
}

export interface ToolDefinition {
  id: ToolId
  group: ToolGroup
  icon: ComponentType<{ className?: string }>
  /**
   * 参数状态归工具自己所有：进「压缩」读不到别的工具的参数，也就不会顺带把上次的裁剪也做了。
   * 工具页按 id 挂 key，换工具就是一次干净的 mount，这个 hook 的调用顺序不会错位。
   */
  useController: () => ToolController
}
