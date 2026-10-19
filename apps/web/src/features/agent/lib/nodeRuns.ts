import type { AgentCanvasRunProposal, StageAuthorization } from '@image-playground/shared'
import { accountScope } from '../../../lib/authScope'
import type { NodeBatchError, NodeBatchJob } from '../../canvas/lib/nodeBatch'
import { agentNodeRunBridge } from './nodeRunBridge'
import { stageAuthorizationClient } from './stageAuthorizationClient'

export const AGENT_NODE_RUN_UNDO_SECONDS = 5
interface RunBase {
  readonly jobs: readonly NodeBatchJob[]
  readonly credits?: number
  readonly authorization?: StageAuthorization
}
export type AgentNodeRun = RunBase & (
  | { readonly status: 'confirming' }
  | { readonly status: 'countdown'; readonly remaining: number }
  | { readonly status: 'running'; readonly completed: number; readonly active: string }
  | { readonly status: 'done' }
  | { readonly status: 'undone' }
  | { readonly status: 'failed'; readonly error: NodeBatchError; readonly completed: number }
)
// Execution rights live only in this document. Reloads, snapshots and other tabs cannot acquire them.
const origins = new Set<string>()
const runs = new Map<string, AgentNodeRun>()
const controls = new Map<string, { control: AbortController; authorizationId: string }>()
const listeners = new Set<() => void>()
export function registerAgentNodeRunOrigin(key: string) { origins.add(key); for (const listener of listeners) listener() }
export const isAgentNodeRunOrigin = (key: string) => origins.has(key)
export const agentNodeRun = (key: string) => runs.get(key)
export function subscribeAgentNodeRuns(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function publish(key: string, run: AgentNodeRun) {
  runs.set(key, run)
  for (const listener of listeners) listener()
}
/** Explicit confirmation is the only entry. The BFF grants a token once, before the undo window. */
export function startAgentNodeRun(key: string, proposal: AgentCanvasRunProposal, undoSeconds = AGENT_NODE_RUN_UNDO_SECONDS): boolean {
  if (!origins.has(key) || runs.has(key)) return false
  const plan = agentNodeRunBridge()?.quote(proposal)
  if (!plan || plan.error || plan.blocked) return false
  const sameAccount = accountScope()
  const base: RunBase = { jobs: plan.jobs, credits: plan.credits }
  const control = new AbortController()
  controls.set(key, { control, authorizationId: proposal.authorizationId })
  publish(key, { ...base, status: 'confirming' })
  void (async () => {
    let authorization: StageAuthorization | undefined
    try {
      const confirmed = await stageAuthorizationClient.confirm(proposal.authorizationId)
      authorization = confirmed.authorization
      if (control.signal.aborted || !sameAccount()) return
      if (undoSeconds > 0) await new Promise<void>((resolve) => {
        let remaining = undoSeconds
        publish(key, { ...base, authorization, status: 'countdown', remaining })
        const timer = setInterval(() => {
          remaining -= 1
          if (remaining > 0) publish(key, { ...base, authorization, status: 'countdown', remaining })
          else { clearInterval(timer); resolve() }
        }, 1000)
        control.signal.addEventListener('abort', () => { clearInterval(timer); resolve() }, { once: true })
      })
      if (control.signal.aborted || !sameAccount()) return
      const bridge = agentNodeRunBridge()
      if (bridge?.projectId !== proposal.projectId) throw Object.assign(new Error('changed'), { code: 'changed' })
      publish(key, { ...base, authorization, status: 'running', completed: 0, active: plan.jobs[0]?.id ?? '' })
      await bridge.run(proposal, plan.signature, control.signal, (completed, active) => {
        if (!control.signal.aborted) publish(key, { ...base, authorization, status: 'running', completed, active })
      }, confirmed.executionToken)
      authorization = await stageAuthorizationClient.read(proposal.authorizationId)
      publish(key, { ...base, authorization, status: 'done' })
    } catch (error) {
      const run = runs.get(key)
      let code: NodeBatchError = 'failed'
      if (error && typeof error === 'object' && 'code' in error) {
        switch (error.code) {
          case 'empty': case 'cycle': case 'busy': case 'prompt': case 'media': case 'model':
          case 'changed': case 'failed': case 'cancelled': case 'limit': case 'balance': case 'authorization':
            code = error.code
        }
      }
      if (run?.status !== 'undone') publish(key, { ...base, authorization, status: 'failed', error: code, completed: run?.status === 'running' ? run.completed : 0 })
    } finally {
      controls.delete(key)
      if (authorization && sameAccount()) {
        try {
          const ended = await stageAuthorizationClient.end(proposal.authorizationId)
          const run = runs.get(key)
          if (run) publish(key, { ...run, authorization: ended })
        } catch {
          // A lost end receipt cannot authorize a replay: neither token nor execution rights persist.
        }
      }
    }
  })()
  return true
}
/** Stop prevents all later submissions; already accepted queue tasks continue normally. */
export function stopAgentNodeRun(key: string) {
  const run = runs.get(key), execution = controls.get(key)
  if (!run || !execution) return
  execution.control.abort()
  if (run.status === 'countdown' || run.status === 'confirming') publish(key, { jobs: run.jobs, credits: run.credits, authorization: run.authorization, status: 'undone' })
  void stageAuthorizationClient.end(execution.authorizationId).then((authorization) => {
    const current = runs.get(key)
    if (current) publish(key, { ...current, authorization })
  }).catch(() => {})
}
