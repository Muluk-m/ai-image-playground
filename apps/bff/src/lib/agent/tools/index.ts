import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { AgentMode, AgentToolName } from '@image-playground/shared'
import { clarificationTool } from '../clarification'
import type { AgentImageSource } from '../images'
import {
  type AgentToolOutcome,
  type AgentToolStart,
  toolDeclaration,
  toolResultBlock,
} from './adapter'
import { editImage } from './editImage'
import { generateImage } from './generateImage'
import { generateVideo } from './generateVideo'
import { loadSkill } from './loadSkill'
import { readLibrary } from './readLibrary'
import type { AgentToolContext, AgentToolDeclaration, AgentToolSpec } from './types'

export type { AgentToolOutcome, AgentToolStart } from './adapter'
export { agentToolStage } from './adapter'
export type { AgentToolContext, AgentToolDeclaration, AgentToolDetails } from './types'

const TOOLS: readonly AgentToolSpec[] = [
  generateImage,
  editImage,
  readLibrary,
  generateVideo,
  loadSkill,
]

function find(name: string): AgentToolSpec | undefined {
  return TOOLS.find((tool) => tool.name === name)
}

/**
 * 这一轮模型看得见的工具：先按创作类型过滤，再按部署开关。两道筛子都只管「这一轮」，
 * 历史里已有的工具结果照样认得出来（`isAgentToolName` 与 `agentToolStart/End` 不过筛）。
 */
function present(mode: AgentMode): AgentToolSpec[] {
  return TOOLS.filter((tool) => tool.modes.includes(mode) && (tool.available?.(mode) ?? true))
}

/**
 * 这一轮实际按什么装配。**做不了视频的部署里，视频轮就不是视频轮**：与其给模型挂一份
 * 它调不了的技能清单、再让它承诺一件做不到的事，不如整轮按图片装配——工具、技能与
 * 逐工具指引一起对齐，只有一个不变量要记：mode 是视频，当且仅当这个部署出得了视频。
 * 起轮与技能清单端点都从这里过一道，两边不会各说各的。
 */
export function resolveAgentMode(mode: AgentMode): AgentMode {
  if (mode !== 'video') return mode
  return (generateVideo.available?.('video') ?? true) ? 'video' : 'image'
}

/**
 * 这一轮注册给模型的整份工具清单：注册表里此刻可用的那些，加上澄清工具——它不出工具卡，
 * 所以不在注册表里（`isAgentToolName` 认不出它），但模型每次请求都收到它的声明。
 */
export function agentTurnTools(context: AgentToolContext): AgentTool[] {
  return [...present(context.mode).map((tool) => tool.create(context)), clarificationTool]
}

/**
 * 同一份清单里随请求发出去的那部分声明，不需要运行期 context——预扣估算发生在起轮之前，
 * 拿不到 images / 事件这些东西，但清单的 token 照样得算进去。创作类型是例外：它在起轮前
 * 就定了，而且正是它决定清单里有哪几个工具。
 */
export function agentToolDeclarations(mode: AgentMode): AgentToolDeclaration[] {
  return [...present(mode).map((tool) => tool.declaration()), toolDeclaration(clarificationTool)]
}

/** 系统提示词里逐工具的那几句。与模型收到的清单同一份过滤，两边不会各说各的。 */
export function agentToolGuidance(mode: AgentMode): string[] {
  return present(mode).map((tool) => tool.guidance())
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
  mode: AgentMode,
  toolName: AgentToolName,
  toolCallId: string,
  args: unknown,
  images: AgentImageSource,
): AgentToolStart {
  const call = find(toolName)?.call(args, mode)
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
