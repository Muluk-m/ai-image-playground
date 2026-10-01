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
          beforeDispatch: async ({ requestBytes }) => {
            await db.transaction(async (tx) => {
              const [owned] = await tx
                .select({ id: schema.tasks.id })
                .from(schema.tasks)
                .where(analysisOwnership(taskId, token))
                .for('update')
              if (!owned) {
                controller.abort()
                throw new Error('analysis_lease_lost')
              }
              const changed = await tx
                .update(schema.analysis_model_calls)
                .set({
                  status: 'dispatched',
                  http_dispatch_count: 1,
                  request_bytes: requestBytes,
                  dispatched_at: Date.now(),
                })
                .where(and(callOwnership(), eq(schema.analysis_model_calls.http_dispatch_count, 0)))
                .returning({ id: schema.analysis_model_calls.id })
              if (!changed.length) throw new Error('analysis_already_dispatched')
              await tx
                .update(schema.tasks)
                .set({ upstream_invocation_count: 1 })
                .where(analysisOwnership(taskId, token))
            })
          },
          onAttempt: async (attempt) => {
            // The original executor may record late usage as evidence, but cannot acquire settlement authority.
            await db.transaction(async (tx) => {
              // Match cancel/finalize lock order; late evidence does not regain a lease.
              const [task] = await tx
                .select({ id: schema.tasks.id })
                .from(schema.tasks)
                .where(eq(schema.tasks.id, taskId))
                .for('update')
              if (!task) return
              const recorded = await tx
                .update(schema.analysis_model_calls)
                .set({
                  status:
                    attempt.status === 'completed'
                      ? 'completed'
                      : attempt.httpDispatchCount
                        ? 'unknown'
                        : controller.signal.aborted
                          ? 'cancelled'
                          : 'failed',
                  http_dispatch_count: attempt.httpDispatchCount ?? 0,
                  usage: attempt.usage,
                  request_bytes: attempt.requestBytes,
                  upstream_request_id: attempt.upstreamRequestId,
                  local_rejection: attempt.localRejection?.reason,
                  finished_at: attempt.finishedAt,
                })
                .where(callOwnership())
                .returning({ id: schema.analysis_model_calls.id })
              if (recorded.length)
                await tx
                  .update(schema.tasks)
                  .set({
                    upstream_status: attempt.upstreamStatus ?? null,
                    upstream_invocation_count: attempt.httpDispatchCount ?? 0,
                  })
                  .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.kind, 'analysis')))
            })
          },
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
