export type TaskExecutionHookId = 'masked-edit' | 'agent-batch'

export class MissingTaskExecutionHookError extends Error {
  constructor(readonly hookId: TaskExecutionHookId) {
    super(
      `Task execution hook "${hookId}" is not registered; ensure bootstrap/task-execution is loaded`,
    )
    this.name = 'MissingTaskExecutionHookError'
  }
}

export type MaskedOutputTransform = (bytes: Uint8Array) => Promise<{
  bytes: Uint8Array
  mime: string
  inspection: Record<string, number>
}>

export interface MaskedCropRegion {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export interface MaskedEditExecutionHook {
  protectMaskedOutput(
    sourceDataUrl: string,
    maskDataUrl: string,
    originalSize?: { readonly width: number; readonly height: number },
    crop?: MaskedCropRegion,
  ): Promise<MaskedOutputTransform>
  cropMaskedUpstream(
    request: {
      readonly input_images?: readonly string[]
      readonly mask?: string
      readonly prompt?: string
    },
    crop: MaskedCropRegion,
    originalSize?: { readonly width: number; readonly height: number },
  ): Promise<{
    input_images: string[]
    mask?: string
    prompt?: string
  }>
  isMaskedOutputError(error: unknown): boolean
}

export type AgentBatchAdvancer = (
  cursor: string | null,
  canDispatch: () => boolean,
) => Promise<string | null>

let maskedEditHook: MaskedEditExecutionHook | undefined
let agentBatchAdvancer: AgentBatchAdvancer | undefined

export function registerMaskedEditExecutionHook(hook: MaskedEditExecutionHook): () => void {
  if (maskedEditHook && maskedEditHook !== hook) {
    throw new Error('Task execution hook "masked-edit" is already registered')
  }
  maskedEditHook = hook
  return () => {
    if (maskedEditHook === hook) maskedEditHook = undefined
  }
}

export function getMaskedEditExecutionHook(): MaskedEditExecutionHook {
  if (!maskedEditHook) throw new MissingTaskExecutionHookError('masked-edit')
  return maskedEditHook
}

export function registerAgentBatchAdvancer(advance: AgentBatchAdvancer): () => void {
  if (agentBatchAdvancer && agentBatchAdvancer !== advance) {
    throw new Error('Task execution hook "agent-batch" is already registered')
  }
  agentBatchAdvancer = advance
  return () => {
    if (agentBatchAdvancer === advance) agentBatchAdvancer = undefined
  }
}

export function getAgentBatchAdvancer(): AgentBatchAdvancer {
  if (!agentBatchAdvancer) throw new MissingTaskExecutionHookError('agent-batch')
  return agentBatchAdvancer
}

export function listTaskExecutionHookIds(): TaskExecutionHookId[] {
  const ids: TaskExecutionHookId[] = []
  if (maskedEditHook) ids.push('masked-edit')
  if (agentBatchAdvancer) ids.push('agent-batch')
  return ids
}

export function _resetTaskExecutionHooksForTesting(): void {
  maskedEditHook = undefined
  agentBatchAdvancer = undefined
}
