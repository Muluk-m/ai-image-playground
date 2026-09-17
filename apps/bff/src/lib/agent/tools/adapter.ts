import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type {
  AgentToolResultBlock,
  AgentToolStage,
  AgentToolStartEvent,
} from '@image-playground/shared'
import { agentTextFromBlocks } from '@image-playground/shared'
import type { TSchema } from 'typebox'
import { Value } from 'typebox/value'
import type { AgentToolArgs, AgentToolDefinition, AgentToolDetails, AgentToolSpec } from './types'

/** 这次调用从起到止一直带着的东西：结果卡的标题与提示词由起跑那一刻定下，不再重算。 */
export type AgentToolStart = Omit<AgentToolStartEvent, 'type' | 'messageId'>

export interface AgentToolOutcome {
  /** 下发与落库的同一个结果块。 */
  readonly block: AgentToolResultBlock
  /** 这次失败要不要把整轮停下。 */
  readonly abortsTurn: boolean
}

/**
 * 工具起跑时 pi 给的 `args` 还是模型的原话：`tool_execution_start` 在 `validateToolArguments`
 * 之前发（pi-agent-core 0.85.1 `dist/agent-loop.js:265`，校验在同文件 `:411`），所以参数可能
 * 缺项、可能类型不对，甚至整个不是对象。这里只沿用 pi 校验时的那一次 `Value.Convert`
 * （pi-ai `dist/utils/validation.js:283`），把 `"3"` 这类字面量换算成它执行时真会用的值；
 * 剩下的残缺留给各工具的 `call()` 退回默认值，这一刻不许抛。
 */
function leniently<P extends TSchema>(parameters: P, args: unknown): AgentToolArgs<P> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {}
  return Value.Convert(parameters, args) as AgentToolArgs<P>
}

/**
 * pi 的工具数组是 `AgentTool<TSchema, any>[]`：工具自己的参数类型与 details 类型进数组时
 * 一定被擦掉。整个 BFF 只在这一处过这座桥。
 */
export function asPiTool<P extends TSchema, D>(tool: AgentTool<P, D>): AgentTool {
  return tool as unknown as AgentTool
}

/** 定义 → 注册表条目。工具那边照常写自己的参数类型，擦除只发生在这里。 */
export function defineAgentTool<P extends TSchema>(
  definition: AgentToolDefinition<P>,
): AgentToolSpec {
  return {
    name: definition.name,
    guidance: definition.guidance,
    onError: definition.onError,
    ...(definition.available ? { available: definition.available } : {}),
    call: (args) => definition.call(leniently(definition.parameters, args)),
    create: (context) =>
      asPiTool<P, AgentToolDetails>({
        name: definition.name,
        label: definition.label,
        description: definition.description,
        parameters: definition.parameters,
        execute: definition.execute(context),
      }),
  }
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
function toolErrorText(result: unknown): string {
  return agentTextFromBlocks(piToolResult(result).content ?? []) || '工具执行失败'
}

export function toolResultBlock(
  start: AgentToolStart,
  result: unknown,
  isError: boolean,
): AgentToolResultBlock {
  const head = {
    type: 'toolResult',
    toolCallId: start.toolCallId,
    toolName: start.toolName,
    ...(start.prompt ? { prompt: start.prompt } : {}),
  } as const
  if (isError) {
    return { ...head, status: 'failed', title: start.title, message: toolErrorText(result) }
  }
  const details = piToolResult<AgentToolDetails>(result).details
  return {
    ...head,
    status: 'succeeded',
    ...(details?.executedPrompt ? { prompt: details.executedPrompt } : {}),
    title: start.title,
    ...(details?.artifacts?.length ? { artifacts: details.artifacts } : {}),
    ...(details?.anchorObjectId ? { anchorObjectId: details.anchorObjectId } : {}),
  }
}
