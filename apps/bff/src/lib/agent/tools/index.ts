import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import type {
  AgentBackgroundJob,
  AgentMode,
  AgentToolCallSnapshot,
  AgentToolErrorCode,
  AgentToolName,
  AgentToolResultBlock,
  AgentTurnParams,
} from '@image-playground/shared'
import { clarificationTool } from '../clarification'
import type { AgentImageSource } from '../images'
import {
  type AgentToolOutcome,
  type AgentToolStart,
  toolDeclaration,
  toolResultBlock,
} from './adapter'
import { editImage } from './editImage'
import type { ToolFailureLog } from './errors'
import { generateImage } from './generateImage'
import { generateVideo } from './generateVideo'
import { loadSkill } from './loadSkill'
import { readLibrary } from './readLibrary'
import type {
  AgentReplayedSubmission,
  AgentSubmissionReplay,
  AgentToolContext,
  AgentToolDeclaration,
  AgentToolDetails,
  AgentToolSpec,
} from './types'

export type { AgentToolOutcome, AgentToolStart } from './adapter'
export { agentToolStage } from './adapter'
export { createToolFailureLog, type ToolFailureLog } from './errors'
export type {
  AgentReplayedSubmission,
  AgentSubmissionReplay,
  AgentToolContext,
  AgentToolDeclaration,
  AgentToolDetails,
} from './types'

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
export function agentTurnTools(context: AgentToolContext, failures?: ToolFailureLog): AgentTool[] {
  return [
    ...present(context.mode).map((spec) => {
      const tool = spec.create(context)
      const execute = tool.execute
      return {
        ...tool,
        execute: async (...args: Parameters<typeof execute>) => {
          const [toolCallId, params, signal] = args
          failures?.started(toolCallId)
          try {
            await context.assertExecution?.()
            const replayed = context.replay && replayedJob(spec, context, params)
            if (replayed) return replayed
            return await execute(...args)
          } catch (thrown) {
            // pi 只留下错误的文字，分类在这里记下，轮收尾时来取。
            failures?.failed(toolCallId, thrown, signal?.aborted ?? false)
            throw thrown
          }
        },
      }
    }),
    clarificationTool,
  ]
}

/**
 * 一次提交调用的幂等键：工具名加上起跑快照里的参数，参数里引用的图换成真实 id——同一张图在两轮
 * 里的编号可能不同，真实 id 不变。`args` 是快照形状的参数，`imageIds` 与它引用的图一一对应。
 */
export function agentSubmissionKey(
  toolName: AgentToolName,
  mode: AgentMode,
  args: unknown,
  imageIds: readonly string[] | undefined,
): string {
  const references = find(toolName)?.call(args, mode).references ?? []
  const ids = new Map<string, string>()
  references.forEach((reference, index) => {
    const id = imageIds?.[index]
    if (id) ids.set(reference, id)
  })
  return JSON.stringify([toolName, canonicalArgs(args, ids)])
}

function canonicalArgs(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return ids.get(value) ?? value
  if (Array.isArray(value)) return value.map((one) => canonicalArgs(one, ids))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, one]) => one !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, one]) => [key, canonicalArgs(one, ids)]),
    )
  return value
}

/** 续跑轮的提交去重：每个已提交的任务只抵掉一次同样的调用，之后同样的调用照常提交。 */
export function createSubmissionReplay(
  submissions: readonly AgentReplayedSubmission[],
): AgentSubmissionReplay {
  const left = [...submissions]
  return {
    take(key) {
      const at = left.findIndex((one) => one.key === key)
      if (at < 0) return undefined
      return left.splice(at, 1)[0]!.job
    },
  }
}

/** 这次调用与被打断那一轮已经提交的一次相同：不再提交，交回那个任务。 */
function replayedJob(
  spec: AgentToolSpec,
  context: AgentToolContext,
  args: unknown,
): AgentToolResult<AgentToolDetails> | undefined {
  if (!spec.snapshot || !context.replay) return undefined
  const snapshot = spec.snapshot(args, context.mode, context.params)
  const imageIds = spec
    .call(args, context.mode)
    .references?.map((reference) => context.images.identify(reference))
  const job = context.replay.take(
    agentSubmissionKey(spec.name, snapshot.mode, snapshot.args, imageIds),
  )
  if (!job) return undefined
  return {
    content: [
      {
        type: 'text',
        text: `这次调用与被打断的那一轮已经提交的后台任务完全相同，没有重复提交。任务仍在后台进行，完成后自动放到用户的画布上；结果出来之前不要说已经生成好。任务 id：${job.taskId}`,
      },
    ],
    details: { job },
  }
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
  params?: AgentTurnParams,
): AgentToolStart {
  const spec = find(toolName)
  const call = spec?.call(args, mode)
  const anchorObjectId = call?.anchor ? images.identify(call.anchor) : undefined
  const snapshot = spec?.snapshot?.(args, mode, params)
  const imageIds = call?.references?.map((reference) => images.identify(reference))
  return {
    toolCallId,
    toolName,
    title: call?.title ?? toolName,
    ...(call?.prompt ? { prompt: call.prompt } : {}),
    ...(call?.outputCount ? { outputCount: call.outputCount } : {}),
    ...(anchorObjectId ? { anchorObjectId } : {}),
    ...(snapshot ? { snapshot: { ...snapshot, ...(imageIds?.length ? { imageIds } : {}) } } : {}),
  }
}

/**
 * 起跑时落库的参数快照还原出的自述：轮在工具半截被打断、结果卡没来得及写时，补写结果卡用它。
 * 快照里的图片已经是真实 id，不必再过一遍本轮的图片表；锚点那时没记下，就近落。
 */
export function agentToolStartFromSnapshot(
  toolName: AgentToolName,
  toolCallId: string,
  snapshot: AgentToolCallSnapshot,
): AgentToolStart {
  const call = find(toolName)?.call(snapshot.args, snapshot.mode)
  return {
    toolCallId,
    toolName,
    title: call?.title ?? toolName,
    ...(call?.prompt ? { prompt: call.prompt } : {}),
    ...(call?.outputCount ? { outputCount: call.outputCount } : {}),
    snapshot,
  }
}

/** 已经提交了后台任务的那次调用的结果卡，与工具正常收尾时写的是同一个形状。 */
export function agentToolSubmittedBlock(
  start: AgentToolStart,
  job: AgentBackgroundJob,
): AgentToolResultBlock {
  return toolResultBlock(start, { content: [], details: { job } }, null)
}

/** 工具收尾这一刻：下发与落库的结果块，外加这次失败要不要把整轮停下。 */
export function agentToolEnd(
  start: AgentToolStart,
  result: unknown,
  failure: AgentToolErrorCode | null,
): AgentToolOutcome {
  return {
    block: toolResultBlock(start, result, failure),
    abortsTurn: failure !== null && find(start.toolName)?.onError === 'abort',
  }
}
