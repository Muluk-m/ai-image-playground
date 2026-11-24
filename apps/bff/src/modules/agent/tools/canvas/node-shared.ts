import { type CanvasOrigin, parseCompleteStageVideoDraft } from '@image-playground/shared'
import { Type } from 'typebox'
import type * as Y from 'yjs'
import { agentCanvasProject } from '../../../../lib/agent/node-canvas-view'
import {
  agentVideoAvailable,
  NO_VIDEO_MODEL_MESSAGE,
  videoNodeModeRejection,
} from '../../../../lib/agent/video-models'
import { isCapabilityEnabled } from '../../../../lib/capabilities'
import {
  CanvasValidationError,
  type CanvasVideoModeCheck,
  executeCanvasCommand,
} from '../../../canvas'
import { type AgentToolAudience, type AgentToolContext, AgentToolError } from '../../contracts'

export const nodeIdSchema = Type.String({ minLength: 1, maxLength: 128 })

export const videoModeSchema = Type.Union([
  Type.Literal('text'),
  Type.Literal('first'),
  Type.Literal('frames'),
  Type.Literal('reference'),
])

export const nodeCommonFields = {
  x: Type.Optional(Type.Number({ minimum: -1000000, maximum: 1000000 })),
  y: Type.Optional(Type.Number({ minimum: -1000000, maximum: 1000000 })),
  width: Type.Optional(Type.Number({ minimum: 40, maximum: 5000 })),
  height: Type.Optional(Type.Number({ minimum: 40, maximum: 5000 })),
  name: Type.Optional(
    Type.String({
      maxLength: 120,
      description: '仅 text、image、video 节点可设名称；timeline 与 storyboard 节点不要传 name。',
    }),
  ),
  text: Type.Optional(Type.String({ maxLength: 100000 })),
  prompt: Type.Optional(Type.String({ maxLength: 100000 })),
  videoMode: Type.Optional(videoModeSchema),
}

export const nodeCanvasModes = ['image', 'video'] as const

export const nodeCanvasAvailable = (_mode: unknown, audience?: AgentToolAudience) =>
  Boolean(
    audience?.userId && audience.experience === 'canvas' && isCapabilityEnabled('accounts:sync'),
  )

export const nodeCanvasGuidance =
  '分镜表的首帧不要用这些工具手工搭，用 runStoryboardFrames。修改前用 readCanvas 读取需要的节点。一次调用会原子保存并可整体撤销，不运行生成、不计费。视频节点必须明确给出 videoMode，不能依引用数量推断。出图和改图（包括参考一张图修改另一张）都用 image 节点，只有用户明确要视频才建 video 节点。用户在对话里附的图要接进节点时，用 createNodes 的 imageId 建素材节点再 connectNodes，不要让用户自己把图拖进画布或选中节点。'

export const invalidCanvasToolParam = (message: string): never => {
  throw new AgentToolError('invalid_params', message)
}

export const throwNoVideoModel = (): never => {
  throw new AgentToolError('model_unavailable', NO_VIDEO_MODEL_MESSAGE)
}

export function runCanvasOp<T>(fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    if (error instanceof CanvasValidationError) invalidCanvasToolParam(error.message)
    throw error
  }
}

export async function runCanvasOpAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof CanvasValidationError) invalidCanvasToolParam(error.message)
    throw error
  }
}

/**
 * 视频节点要写的模式在它实际会用的模型上必须支持：没有可用视频模型就不建，不支持的模式直接报错并列出支持的，
 * 不再像以前那样悄悄退成首帧（图生视频）、照扣视频积分。模型按节点草稿、再按本轮工作台挑，与报价一致。
 */
export function videoModeCheck(params: AgentToolContext['params']): CanvasVideoModeCheck {
  return (mode, meta) => {
    if (!agentVideoAvailable()) throwNoVideoModel()
    const rejected = videoNodeModeRejection(
      mode,
      parseCompleteStageVideoDraft(meta.nodeVideoDraft)?.model ?? params?.video?.model,
    )
    if (rejected) invalidCanvasToolParam(rejected)
  }
}

export async function writeAgentCanvas(
  context: AgentToolContext,
  toolCallId: string,
  label: string,
  args: unknown,
  mutate: (doc: Y.Doc, origin: CanvasOrigin) => void,
) {
  if (!nodeCanvasAvailable(context.mode, context))
    invalidCanvasToolParam('当前会话没有可写的云端节点画布。')
  const project = await agentCanvasProject(context)
  if (!project || !context.userId) return invalidCanvasToolParam('当前会话没有已同步的云端项目。')
  await context.assertExecution?.()
  const result = await runCanvasOpAsync(() =>
    executeCanvasCommand(
      context.userId!,
      project.id,
      { turnId: context.turnId, toolCallId, label, args },
      mutate,
    ),
  )
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          ...result,
          saved: true,
          note: '已保存到服务端画布，可撤销；没有启动生成任务。',
        }),
      },
    ],
    details: {},
  }
}
