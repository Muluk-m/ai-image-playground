import {
  type AgentBatchAdvancer,
  type MaskedEditExecutionHook,
  registerAgentBatchAdvancer,
  registerMaskedEditExecutionHook,
} from '../modules/execution/task-execution-hooks'

const MASKED_OUTPUT_ERROR_TAG = Symbol.for('image-playground.masked-output-error')

let maskedOutputErrorClass: (abstract new (...args: never[]) => Error) | undefined

const defaultMaskedEditExecutionHook: MaskedEditExecutionHook = {
  async protectMaskedOutput(sourceDataUrl, maskDataUrl, originalSize, crop) {
    const mod = await import('../modules/agent/orchestration/masked/pure')
    maskedOutputErrorClass = mod.MaskedOutputError
    return mod.protectMaskedOutput(sourceDataUrl, maskDataUrl, originalSize, crop)
  },
  async cropMaskedUpstream(request, crop, originalSize) {
    const { cropMaskedUpstream } = await import('../modules/agent/orchestration/masked/pure')
    return cropMaskedUpstream(request, crop, originalSize)
  },
  isMaskedOutputError(error) {
    return (
      (maskedOutputErrorClass !== undefined && error instanceof maskedOutputErrorClass) ||
      (error instanceof Error && MASKED_OUTPUT_ERROR_TAG in error)
    )
  },
}

const defaultAgentBatchAdvancer: AgentBatchAdvancer = async (cursor, canDispatch) => {
  const { advanceAgentBatches } = await import('../modules/agent/orchestration')
  return advanceAgentBatches(cursor, canDispatch)
}

/**
 * 组合根注册内置的任务执行扩展钩子（幂等）：
 * 保持 `workers/` 与 `modules/execution/` 零依赖 `lib/agent/*`；
 * 仅静态导入无配置副作用的 `task-execution-hooks`，使单测辅助文件可在设置 env 前安全引入。
 */
export function registerDefaultTaskExecutionHooks(): void {
  registerMaskedEditExecutionHook(defaultMaskedEditExecutionHook)
  registerAgentBatchAdvancer(defaultAgentBatchAdvancer)
}

registerDefaultTaskExecutionHooks()
