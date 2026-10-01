import { createHash } from 'node:crypto'
import type { AgentTurnUsage } from '@image-playground/shared'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/client'
import {
  ANALYSIS_LEASE_MS,
  analysisFindings,
  finalizeAnalysisTask,
  refreshAnalysisTaskCosts,
} from './analysis-tasks'
import { type ReconciliationCommand, ReconciliationError } from './task-reconciliation'
import { isObject } from './type-guards'

function reportedUsage(value: unknown): AgentTurnUsage | null {
  if (!isObject(value)) return null
  const { inputTokens, outputTokens, cachedInputTokens = 0 } = value
  if (
    typeof inputTokens !== 'number' ||
    typeof outputTokens !== 'number' ||
    typeof cachedInputTokens !== 'number' ||
    ![inputTokens, outputTokens, cachedInputTokens].every(
      (one) => Number.isSafeInteger(one) && one >= 0,
    ) ||
    cachedInputTokens > inputTokens
  )
    return null
  return { inputTokens, outputTokens, cachedInputTokens }
}

export async function readAnalysisReconciliation(taskId: string) {
  const [analysis] = await db
    .select()
    .from(schema.analysis_tasks)
    .where(eq(schema.analysis_tasks.task_id, taskId))
  if (!analysis) return null
  const [call] = await db
    .select()
    .from(schema.analysis_model_calls)
    .where(eq(schema.analysis_model_calls.task_id, taskId))
  const audits = await db
    .select({ details: schema.operator_audits.details })
    .from(schema.operator_audits)
    .where(
      and(
        eq(schema.operator_audits.target_id, taskId),
        eq(schema.operator_audits.action, 'task.reconcile'),
      ),
    )
  return {
    taskId,
    kind: 'analysis' as const,
    status: analysis.status,
    enabled: true,
    upstreamTaskIds: [],
    dispatches: call
      ? [
          {
            id: call.id,
            intendedAt: call.started_at,
            dispatchedAt: call.dispatched_at,
            upstreamRequestId: call.upstream_request_id,
          },
        ]
      : [],
    decisions: audits.map((row) => row.details),
    analysis: {
      model: analysis.model,
      pricing: analysis.price_snapshot,
      reservedCredits: analysis.reserved_credits,
      actualCredits: analysis.actual_credits,
      findings: analysis.findings,
      coverage: analysis.coverage,
      evidence: analysis.evidence,
      usage: call?.usage ?? null,
      localRejection: call?.local_rejection ?? null,
    },
  }
}

/** Only reads saved model evidence; Chat Completions has no generation polling endpoint. */
export async function reconcileAnalysisTask(taskId: string, command: ReconciliationCommand) {
  if (!command.operatorId.trim() || !command.evidence.trim())
    throw new ReconciliationError('reconciliation_evidence_required', 400)
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        command.action,
        command.operatorId,
        command.evidence,
        command.result ?? null,
      ]),
    )
    .digest('hex')
  const auditId = `task-reconcile:${createHash('sha256')
    .update(JSON.stringify([taskId, command.commandId]))
    .digest('hex')}`
  const result = await db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.kind, 'analysis')))
      .for('update')
    if (!task) throw new ReconciliationError('task_not_found', 404)
    const [prior] = await tx
      .select()
      .from(schema.operator_audits)
      .where(eq(schema.operator_audits.id, auditId))
    if (prior) {
      if (prior.details.digest !== digest)
        throw new ReconciliationError('reconciliation_command_conflict')
      return {
        taskId,
        status: prior.details.status,
        ...(typeof prior.details.reason === 'string' ? { reason: prior.details.reason } : {}),
      }
    }
    if (task.status !== 'reconciling') throw new ReconciliationError('task_not_reconciling')
    const [analysis] = await tx
      .select()
      .from(schema.analysis_tasks)
      .where(eq(schema.analysis_tasks.task_id, taskId))
    const [call] = await tx
      .select()
      .from(schema.analysis_model_calls)
      .where(eq(schema.analysis_model_calls.task_id, taskId))
      .for('update')
    if (!analysis || !call) throw new ReconciliationError('task_not_found', 404)
    const audits = await tx
      .select({ details: schema.operator_audits.details })
      .from(schema.operator_audits)
      .where(
        and(
          eq(schema.operator_audits.target_id, taskId),
          eq(schema.operator_audits.action, 'task.reconcile'),
        ),
      )
    if (command.action !== 'lookup' && !audits.some((row) => row.details.action === 'lookup'))
      throw new ReconciliationError('reconciliation_lookup_required')
    let reason: string | undefined
    if (command.action === 'confirm_success') {
      const findings = analysisFindings(
        JSON.stringify(command.result ?? null),
        analysis.input_snapshot.inputs,
      )
      const usage = reportedUsage(command.result?.usage)
      if (!findings || !usage) throw new ReconciliationError('analysis_result_required', 400)
      await tx
        .update(schema.analysis_model_calls)
        .set({
          response_content: JSON.stringify({ findings }),
          usage,
          status: 'completed',
          execution_token: null,
          finished_at: Date.now(),
        })
        .where(eq(schema.analysis_model_calls.id, call.id))
    } else if (command.action === 'lookup' && (!call.usage || call.response_content === null)) {
      reason = 'manual_verification_required'
    }
    if (!reason) {
      const token = crypto.randomUUID()
      await tx
        .update(schema.tasks)
        .set({
          status: 'in_progress',
          execution_token: token,
          lease_expires_at: Date.now() + ANALYSIS_LEASE_MS,
        })
        .where(eq(schema.tasks.id, taskId))
      if (
        !(await finalizeAnalysisTask(taskId, token, {
          tx,
          confirmedNoResult: command.action === 'confirm_no_result',
        }))
      )
        throw new ReconciliationError('reconciliation_lease_lost')
    }
    const [settled] = await tx
      .select({ status: schema.analysis_tasks.status })
      .from(schema.analysis_tasks)
      .where(eq(schema.analysis_tasks.task_id, taskId))
    const status = settled!.status
    await tx.insert(schema.operator_audits).values({
      id: auditId,
      operator_id: command.operatorId,
      action: 'task.reconcile',
      target_type: 'task',
      target_id: taskId,
      created_at: Date.now(),
      details: {
        commandId: command.commandId,
        operatorId: command.operatorId,
        action: command.action,
        evidence: command.evidence,
        digest,
        status,
        ...(reason ? { reason } : {}),
        kind: 'analysis',
        callId: call.id,
      },
    })
    return { taskId, status, ...(reason ? { reason } : {}) }
  })
  if (result.status !== 'reconciling') await refreshAnalysisTaskCosts([taskId])
  return result
}
