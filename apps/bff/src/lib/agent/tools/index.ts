import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { AgentToolName } from '@image-playground/shared'
import type { AgentImageSource } from '../images'
import { type AgentToolOutcome, type AgentToolStart, toolResultBlock } from './adapter'
import { editImage } from './editImage'
import { generateImage } from './generateImage'
import { generateVideo } from './generateVideo'
import { readLibrary } from './readLibrary'
import type { AgentToolContext, AgentToolSpec } from './types'

export type { AgentToolOutcome, AgentToolStart } from './adapter'
export { agentToolStage } from './adapter'
export type { AgentToolContext, AgentToolDetails } from './types'

const TOOLS: readonly AgentToolSpec[] = [generateImage, editImage, readLibrary, generateVideo]

function find(name: string): AgentToolSpec | undefined {
  return TOOLS.find((tool) => tool.name === name)
}

function present(): AgentToolSpec[] {
  return TOOLS.filter((tool) => tool.available?.() ?? true)
}

export function agentTools(context: AgentToolContext): AgentTool[] {
  return present().map((tool) => tool.create(context))
}

/** 系统提示词里逐工具的那几句。与模型收到的清单同一份过滤，两边不会各说各的。 */
export function agentToolGuidance(): string[] {
  return present().map((tool) => tool.guidance)
}

export function isAgentToolName(name: string): name is AgentToolName {
  return find(name) !== undefined
}

/**
 * 工具起跑这一刻，轮要发出去的全部：标题、完整提示词，以及让画布在工具跑完之前就占好位的
 * 「占几个、占在哪」——参数与锚点这一刻都在手上，等到结束再说就晚了整整一次生成。
 * 结果块后面照这份自述出，所以一次调用只问这一次。
 */
export function agentToolStart(
  toolName: AgentToolName,
  toolCallId: string,
  args: unknown,
  images: AgentImageSource,
): AgentToolStart {
  const call = find(toolName)?.call(args)
  const anchorObjectId = call?.anchor ? images.identify(call.anchor) : undefined
  return {
    toolCallId,
    toolName,
    title: call?.title ?? toolName,
    ...(call?.prompt ? { prompt: call.prompt } : {}),
    ...(call?.outputCount ? { outputCount: call.outputCount } : {}),
    ...(anchorObjectId ? { anchorObjectId } : {}),
  }
}

/** 工具收尾这一刻：下发与落库的结果块，外加这次失败要不要把整轮停下。 */
export function agentToolEnd(
  start: AgentToolStart,
  result: unknown,
  isError: boolean,
): AgentToolOutcome {
  return {
    block: toolResultBlock(start, result, isError),
    abortsTurn: isError && find(start.toolName)?.onError === 'abort',
  }
}
