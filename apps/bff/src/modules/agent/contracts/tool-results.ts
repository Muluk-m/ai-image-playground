import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type {
  AgentToolErrorCode,
  AgentToolResultBlock,
  AgentToolStage,
} from '@image-playground/shared'
import { agentTextFromBlocks } from '@image-playground/shared'
import type { TSchema } from 'typebox'
import type { AgentToolStart } from './events'
import type { AgentToolDeclaration, AgentToolDetails } from './tool-context'

/**
 * pi 的工具数组是 `AgentTool<TSchema, any>[]`：工具自己的参数类型与 details 类型进数组时
 * 一定被擦掉。整个 BFF 只在这一处过这座桥。
 */
export function asPiTool<P extends TSchema, D>(tool: AgentTool<P, D>): AgentTool {
  return tool as unknown as AgentTool
}

/**
 * 每次请求都随请求发出去的那一部分：pi 把名称、说明与参数 schema 写进工具清单，
 * `label` 与 `execute` 留在进程里。注册与预扣估算读的是同一份，不会各列各的。
 */
export function toolDeclaration(tool: AgentTool): AgentToolDeclaration {
  return { name: tool.name, description: tool.description, parameters: tool.parameters }
}

/**
 * pi 把工具结果按 `any` 发出来（`AgentEvent` 的 `result` 与 `partialResult`）；这是整个 BFF
 * 唯一一处把它读回我们自己的形状。
 */
export function piToolResult<D>(result: unknown): Partial<AgentToolResult<D>> {
  return (result ?? {}) as Partial<AgentToolResult<D>>
}

/** 分钟级任务的中途进度；工具没报 stage 就没有进度可发。 */
export function agentToolStage(partialResult: unknown): AgentToolStage | undefined {
  return piToolResult<AgentToolDetails>(partialResult).details?.stage
}

/** pi 把工具抛出的错误写成结果的文字块。 */
export function toolErrorText(result: unknown): string {
  return agentTextFromBlocks(piToolResult(result).content ?? []) || '工具执行失败'
}

export function toolResultBlock(
  start: AgentToolStart,
  result: unknown,
  failure: AgentToolErrorCode | null,
): AgentToolResultBlock {
  const head = {
    type: 'toolResult',
    toolCallId: start.toolCallId,
    toolName: start.toolName,
    ...(start.prompt ? { prompt: start.prompt } : {}),
    ...(start.snapshot ? { snapshot: start.snapshot } : {}),
  } as const
  if (failure) {
    return {
      ...head,
      status: 'failed',
      title: start.title,
      message: toolErrorText(result),
      errorCode: failure,
    }
  }
  const details = piToolResult<AgentToolDetails>(result).details
  if (details?.clarification)
    return {
      type: 'toolResult',
      toolCallId: start.toolCallId,
      toolName: start.toolName,
      status: 'succeeded',
      title: '等待确认图片组合',
      message: '尚未创建生成任务。',
    }
  if (details?.awaitingConfirmation) {
    // 只拟了稿：卡片停在这里等用户确认，锚点先记下，确认提交后产出照它落位。
    return {
      ...head,
      status: 'awaiting_confirmation',
      ...(details.productionDraftRevision
        ? { productionDraftRevision: details.productionDraftRevision }
        : {}),
      ...(details.video ? { video: details.video } : {}),
      ...(details.executedPrompt ? { prompt: details.executedPrompt } : {}),
      title: start.title,
      ...(details.anchorObjectId ? { anchorObjectId: details.anchorObjectId } : {}),
      ...(details.gated ? { gated: true as const } : {}),
      ...(details.gateReceipt ? { gateReceipt: details.gateReceipt } : {}),
    }
  }
  if (details?.job) {
    // 后台任务：调用已经收尾，结局要等任务结束再由服务端改写（见 `background-jobs.ts`）。
    return {
      ...head,
      status: 'submitted',
      ...(details.executedPrompt ? { prompt: details.executedPrompt } : {}),
      title: start.title,
      ...(details.anchorObjectId ? { anchorObjectId: details.anchorObjectId } : {}),
      job: details.job,
    }
  }
  return {
    ...head,
    status: 'succeeded',
    ...(details?.batchId ? { batchId: details.batchId } : {}),
    ...(details?.batchItemKeys?.length ? { batchItemKeys: details.batchItemKeys } : {}),
    ...(details?.analysisLimit ? { analysisLimit: details.analysisLimit } : {}),
    ...(details?.executedPrompt ? { prompt: details.executedPrompt } : {}),
    title: start.title,
    ...(details?.artifacts?.length ? { artifacts: details.artifacts } : {}),
    ...(details?.anchorObjectId ? { anchorObjectId: details.anchorObjectId } : {}),
    ...(details?.skill ? { skill: details.skill } : {}),
    ...(details?.timeline ? { timeline: details.timeline } : {}),
    ...(details?.canvasRead ? { canvasRead: details.canvasRead } : {}),
    ...(details?.canvasRun ? { canvasRun: details.canvasRun } : {}),
    ...(details?.canvasEdit ? { canvasEdit: details.canvasEdit } : {}),
    ...(details?.saveCard ? { saveCard: details.saveCard } : {}),
    ...(details?.sources?.length ? { sources: details.sources } : {}),
    ...(details?.fetchedImages?.length ? { fetchedImages: details.fetchedImages } : {}),
    ...(details?.visualObservations?.length
      ? { visualObservations: details.visualObservations }
      : {}),
  }
}
