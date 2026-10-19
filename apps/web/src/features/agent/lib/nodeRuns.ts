import type { AgentCanvasRunProposal } from '@image-playground/shared'
// 只取类型：对话 store 引入本模块，不能把画布批次模块整个拉进对话侧。
import type { NodeBatchError, NodeBatchJob } from '../../canvas/lib/nodeBatch'
import { agentNodeRunBridge } from './nodeRunBridge'

/** 出图模式开跑前留给用户撤销的秒数；倒计时内没有提交任何任务。 */
export const AGENT_NODE_RUN_UNDO_SECONDS = 5

interface RunBase {
  readonly jobs: readonly NodeBatchJob[]
  readonly credits?: number
}
export type AgentNodeRun = RunBase &
  (
    | { readonly status: 'countdown'; readonly remaining: number }
    | { readonly status: 'running'; readonly completed: number; readonly active: string }
    | { readonly status: 'done' }
    | { readonly status: 'undone' }
    | { readonly status: 'failed'; readonly error: NodeBatchError; readonly completed: number }
  )

// 运行不跟着卡片走：面板收起、卡片卸载都不中断；同一张卡在这个标签页里只跑一次。
const runs = new Map<string, AgentNodeRun>()
const controls = new Map<string, AbortController>()
const listeners = new Set<() => void>()

function publish(key: string, run: AgentNodeRun) {
  runs.set(key, run)
  for (const listener of listeners) listener()
}

function batchError(error: unknown): NodeBatchError {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? (code as NodeBatchError) : 'failed'
}

export const agentNodeRun = (key: string) => runs.get(key)

export function subscribeAgentNodeRuns(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 按当前画布报价运行一张卡的节点；`undoSeconds` 大于 0 时先倒计时，期间可撤销。
 * 画布未打开、报价不可用或这张卡已经跑过时返回 false，不做任何事。
 */
export function startAgentNodeRun(
  key: string,
  proposal: AgentCanvasRunProposal,
  undoSeconds = 0,
): boolean {
  if (runs.has(key)) return false
  const plan = agentNodeRunBridge()?.quote(proposal)
  if (!plan || plan.error || plan.blocked) return false
  const base: RunBase = {
    jobs: plan.jobs,
    ...(plan.credits !== undefined ? { credits: plan.credits } : {}),
  }
  const control = new AbortController()
  controls.set(key, control)
  let completed = 0
  const execute = () => {
    const bridge = agentNodeRunBridge()
    publish(key, { ...base, status: 'running', completed, active: plan.jobs[0]?.id ?? '' })
    const running =
      bridge?.projectId === proposal.projectId
        ? bridge.run(proposal, plan.signature, control.signal, (count, active) => {
            completed = count
            if (!control.signal.aborted)
              publish(key, { ...base, status: 'running', completed, active })
          })
        : Promise.reject({ code: 'changed' })
    running
      .then(
        () => publish(key, { ...base, status: 'done' }),
        (error: unknown) =>
          publish(key, {
            ...base,
            status: 'failed',
            error: batchError(error),
            completed,
          }),
      )
      .finally(() => controls.delete(key))
  }
  if (undoSeconds <= 0) {
    execute()
    return true
  }
  let remaining = undoSeconds
  publish(key, { ...base, status: 'countdown', remaining })
  const timer = setInterval(() => {
    remaining -= 1
    if (remaining > 0) return publish(key, { ...base, status: 'countdown', remaining })
    clearInterval(timer)
    execute()
  }, 1000)
  control.signal.addEventListener('abort', () => clearInterval(timer), { once: true })
  return true
}

/** 倒计时内撤销（什么都没提交）；运行中停止后续节点，已提交的任务照常完成。 */
export function stopAgentNodeRun(key: string) {
  const run = runs.get(key)
  const control = controls.get(key)
  if (!run || !control) return
  control.abort()
  if (run.status !== 'countdown') return
  controls.delete(key)
  publish(key, {
    jobs: run.jobs,
    ...(run.credits !== undefined ? { credits: run.credits } : {}),
    status: 'undone',
  })
}
