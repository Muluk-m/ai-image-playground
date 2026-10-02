import { isDeepStrictEqual } from 'node:util'
import { and, eq } from 'drizzle-orm'
import { config } from '../config'
import { db, schema } from '../db/client'
import { AgentContextOverflow } from '../lib/agent/request-budget'
import { AgentToolError } from '../lib/agent/tools/errors'
import { withVisualSignal } from '../lib/agent/visual-resources'
import {
  ANALYSIS_LEASE_MS,
  analysisOwnership,
  analysisRequestPrompt,
  claimAnalysisTask,
  finalizeAnalysisTask,
  prepareAnalysisTask,
  recordAnalysisAttempt,
} from '../lib/analysis-tasks'
import { askChatModelOnce } from '../lib/chatCompletion'

const running = new Map<string, AbortController>()
export const runningAnalysisTaskIds = () => [...running.keys()]
export function abortRunningAnalysisTask(taskId: string): void {
  running.get(taskId)?.abort()
}
export function abortAllRunningAnalysisTasks(): void {
  for (const controller of running.values()) controller.abort()
}

/** One independently accounted call. A saved response resumes settlement without another dispatch. */
export async function runAnalysisTask(taskId: string): Promise<void> {
  const claim = await claimAnalysisTask(taskId)
  if (!claim) return
  const { token, analysis, call } = claim
  const controller = new AbortController()
  running.set(taskId, controller)
  let renewing = false
  const heartbeat = setInterval(() => {
    if (renewing) return
    renewing = true
    void db
      .update(schema.tasks)
      .set({ lease_expires_at: Date.now() + ANALYSIS_LEASE_MS })
      .where(analysisOwnership(taskId, token))
      .returning({ id: schema.tasks.id })
      .then((rows) => {
        if (!rows.length) controller.abort()
      })
      .catch(() => controller.abort())
      .finally(() => {
        renewing = false
      })
  }, 10_000)
  const callOwnership = () =>
    and(
      eq(schema.analysis_model_calls.id, call.id),
      eq(schema.analysis_model_calls.execution_token, token),
    )
  try {
    if (!call.http_dispatch_count) {
      try {
        controller.signal.throwIfAborted()
        const maxTokens = Math.min(
          config.agent.maxTokens,
          analysis.price_snapshot.outputReserveTokens,
        )
        const prepared = await withVisualSignal(controller.signal, () =>
          prepareAnalysisTask({
            userId: analysis.user_id,
            ...analysis.input_snapshot,
            maxOutputTokens: maxTokens,
            signal: controller.signal,
          }),
        )
        controller.signal.throwIfAborted()
        if (
          prepared.estimatedInputTokens !== analysis.input_snapshot.estimatedInputTokens ||
          !isDeepStrictEqual(prepared.evidence, analysis.input_snapshot.evidence)
        )
          throw new Error('analysis_input_changed')
        const response = await askChatModelOnce({
          attemptId: call.id,
          model: analysis.model,
          prompt: analysisRequestPrompt(prepared),
          images: prepared.images,
          maxTokens,
          timeoutMs: 90_000,
          signal: controller.signal,
          beforeDispatch: async ({ requestBytes, signal }) => {
            const connection = await db.$client.reserve({ signal })
            let active: { cancel(): unknown } | undefined
            const aborted = () => {
              active?.cancel()
            }
            signal.addEventListener('abort', aborted)
            const query = async <T>(pending: Promise<T> & { cancel(): unknown }): Promise<T> => {
              signal.throwIfAborted()
              active = pending
              try {
                return await pending
              } finally {
                active = undefined
              }
            }
            let committed = false
            try {
              await query(connection`BEGIN`)
              const owned = await query(
                connection`SELECT id FROM tasks WHERE id = ${taskId} AND kind = 'analysis' AND status = 'in_progress' AND execution_token = ${token} AND lease_expires_at > ${new Date()} FOR UPDATE`,
              )
              if (!owned.length) {
                controller.abort()
                throw new Error('analysis_lease_lost')
              }
              const changed = await query(
                connection`UPDATE analysis_model_calls SET status = 'dispatched', http_dispatch_count = 1, request_bytes = ${requestBytes}, dispatched_at = ${new Date()} WHERE id = ${call.id} AND task_id = ${taskId} AND execution_token = ${token} AND http_dispatch_count = 0 AND status = 'prepared' RETURNING id`,
              )
              if (!changed.length) throw new Error('analysis_already_dispatched')
              await query(
                connection`UPDATE tasks SET upstream_invocation_count = 1 WHERE id = ${taskId} AND execution_token = ${token} AND status = 'in_progress'`,
              )
              await query(connection`COMMIT`)
              committed = true
            } finally {
              signal.removeEventListener('abort', aborted)
              try {
                if (!committed) await connection`ROLLBACK`
              } finally {
                connection.release()
              }
            }
          },
          onAttempt: (attempt) =>
            recordAnalysisAttempt(taskId, call.id, token, attempt, controller.signal.aborted),
        })
        // Empty content is a known invalid response, distinct from a response that never arrived.
        await db
          .update(schema.analysis_model_calls)
          .set({ response_content: response ?? '' })
          .where(callOwnership())
      } catch (error) {
        const localRejection =
          error instanceof AgentContextOverflow
            ? 'context_overflow'
            : error instanceof AgentToolError
              ? error.code
              : error instanceof Error &&
                  [
                    'analysis_input_changed',
                    'analysis_output_budget_invalid',
                    'analysis_inputs_invalid',
                    'analysis_visual_evidence_missing',
                    'analysis_lease_lost',
                  ].includes(error.message)
                ? error.message
                : controller.signal.aborted
                  ? 'analysis_cancelled'
                  : 'analysis_preparation_failed'
        // Preparation failures have no request. A dispatched call stays unknown until evidence resolves it.
        await db
          .update(schema.analysis_model_calls)
          .set({
            status: controller.signal.aborted ? 'cancelled' : 'failed',
            usage: { inputTokens: 0, outputTokens: 0 },
            local_rejection: localRejection,
            finished_at: Date.now(),
          })
          .where(
            and(
              callOwnership(),
              eq(schema.analysis_model_calls.http_dispatch_count, 0),
              eq(schema.analysis_model_calls.status, 'prepared'),
            ),
          )
      }
    }
    // Keep finalization errors observable: recovery must resume this transaction from the persisted response.
    await finalizeAnalysisTask(taskId, token)
  } finally {
    clearInterval(heartbeat)
    if (running.get(taskId) === controller) running.delete(taskId)
  }
}
