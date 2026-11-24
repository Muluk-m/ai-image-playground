import type { AgentMode, AgentTurnParams } from '@image-playground/shared'
import type { TSchema } from 'typebox'
import { Value } from 'typebox/value'
import {
  type AgentToolArgs,
  type AgentToolDeclaration,
  type AgentToolDefinition,
  type AgentToolDetails,
  type AgentToolOutcome,
  type AgentToolSpec,
  type AgentToolStart,
  agentToolStage,
  asPiTool,
  piToolResult,
  toolDeclaration,
  toolErrorText,
  toolResultBlock,
} from '../../../modules/agent/contracts'
import { registerVisualBlock } from '../visual-input'
import { withVisualSignal } from '../visual-resources'

export {
  type AgentToolOutcome,
  type AgentToolStart,
  agentToolStage,
  asPiTool,
  piToolResult,
  toolDeclaration,
  toolErrorText,
  toolResultBlock,
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
 * 定义 → 注册表条目。工具那边照常写自己的参数类型，擦除只发生在这里。
 *
 * 声明与指引都是**现问的**，不是模块加载那一刻定死的常量：一个工具能做什么可能要到运行期
 * 才解析得出来（生视频的档位跟着这个部署解析到的视频模型走）。`create`、`declaration()` 与
 * `guidance()` 读的仍是同一个算式，所以「模型收到的清单 = 预扣估算的声明 = 系统提示词的指引」
 * 这条不变量没有松动。
 */
export function defineAgentTool<P extends TSchema>(
  definition: AgentToolDefinition<P>,
): AgentToolSpec {
  const declaration = (): AgentToolDeclaration<P> => ({
    name: definition.name,
    description: definition.description,
    parameters: definition.currentParameters?.() ?? definition.parameters,
  })
  return {
    name: definition.name,
    modes: definition.modes,
    guidance: () =>
      typeof definition.guidance === 'string' ? definition.guidance : definition.guidance(),
    onError: definition.onError,
    ...(definition.confirms ? { confirms: definition.confirms } : {}),
    declaration,
    ...(definition.available ? { available: definition.available } : {}),
    // 起跑这一刻按静态 schema 宽松换算就够：`currentParameters()` 只改说明，不改形状。
    call: (args, mode, turn) => definition.call(leniently(definition.parameters, args), mode, turn),
    ...(definition.target
      ? {
          snapshot: (args: unknown, mode: AgentMode, params: AgentTurnParams | undefined) => {
            const target = definition.target?.(params, leniently(definition.parameters, args))
            return {
              mode,
              args: { ...leniently(definition.parameters, args) } as Record<string, unknown>,
              ...(params ? { params } : {}),
              ...(target ? { target: { provider: target.provider, model: target.model } } : {}),
            }
          },
        }
      : {}),
    create: (context) => {
      const execute = definition.execute(context)
      return asPiTool<P, AgentToolDetails>({
        ...declaration(),
        label: definition.label,
        execute: async (...args) =>
          withVisualSignal(args[2], async () => {
            const result = await execute(...args)
            for (const [index, block] of result.content.entries()) {
              if (block.type === 'image')
                await registerVisualBlock(block, {
                  imageId: `tool:${args[0]}:${index}`,
                  source: definition.name,
                  representation: 'tool-output',
                  selection: false,
                })
            }
            context.visualWorkset?.admit(result.content.filter((block) => block.type === 'image'))
            return result
          }),
      })
    },
  }
}
