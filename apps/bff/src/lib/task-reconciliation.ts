import { createHash } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import sharp from 'sharp'
import { config } from '../config'
import { db, schema } from '../db/client'
import { finishTask, heldBy, type TerminalTaskUpdate } from '../db/task-transitions'
import { protectMaskedOutput } from './agent/masked-output'
import { isCapabilityEnabled } from './capabilities'
import { extractMeta, resolveImageBytesRef } from './extractImages'
import {
  archiveGenerationOutputs,
  missingGenerationOutputs,
  spoolGenerationOutputs,
} from './generationMedia'
import { archiveOutputImages, hydrateInputImages } from './imageArchive'
import { MEDIA_IMAGE_MAX_PIXELS } from './media-image-limits'
import { callUpstream } from './upstream'

export class ReconciliationError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus = 409,
  ) {
    super(code)
  }
}

export async function readTaskReconciliation(taskId: string) {
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)).limit(1)
  if (!task) throw new ReconciliationError('task_not_found', 404)
  const dispatches = await db
    .select({
      id: schema.task_dispatches.id,
      attempt: schema.task_dispatches.execution_token,
      intendedAt: schema.task_dispatches.intended_at,
      dispatchedAt: schema.task_dispatches.dispatched_at,
      upstreamRequestId: schema.task_dispatches.upstream_request_id,
      upstreamTaskId: schema.task_dispatches.upstream_task_id,
    })
    .from(schema.task_dispatches)
    .where(eq(schema.task_dispatches.task_id, taskId))
    .orderBy(asc(schema.task_dispatches.intended_at))
  const audits = await db
    .select({ details: schema.operator_audits.details })
    .from(schema.operator_audits)
    .where(
      and(
        eq(schema.operator_audits.target_id, taskId),
        eq(schema.operator_audits.action, 'task.reconcile'),
      ),
    )
    .orderBy(asc(schema.operator_audits.created_at))
  return {
    taskId,
    status: task.status,
    enabled: task.reconciliation_required,
    upstreamTaskIds: [
      ...new Set([
        ...(task.upstream_task_ids ?? []),
        ...dispatches.flatMap((row) => (row.upstreamTaskId ? [row.upstreamTaskId] : [])),
      ]),
    ],
    dispatches,
    decisions: audits.map(({ details }) => details),
  }
}

export interface ReconciliationCommand {
  commandId: string
  operatorId: string
  evidence: string
  action: 'confirm_no_result' | 'confirm_success' | 'lookup'
  result?: Record<string, unknown>
}

const RECONCILIATION_LEASE_MS = 60_000
const RECONCILIATION_HEARTBEAT_MS = 10_000

function validResult(task: typeof schema.tasks.$inferSelect, payload: unknown, manual: boolean) {
  const images = extractMeta(task.provider, payload).images
  return (
    images.length > 0 &&
    images.every((image) => {
      const ref = resolveImageBytesRef(task.provider, payload, image.index)
      return (
        ref &&
        ref.mime.startsWith('image/') &&
        (!manual || ref.kind === 'b64' || ref.kind === 'url')
      )
    })
  )
}

export async function reconcileTask(taskId: string, command: ReconciliationCommand) {
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
  const token = crypto.randomUUID()
  const claim = await db.transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.id, taskId))
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
        kind: 'replay' as const,
        result: {
          taskId,
          status: prior.details.status,
          ...(typeof prior.details.reason === 'string' ? { reason: prior.details.reason } : {}),
        },
      }
    }
    if (task.status !== 'reconciling' || !task.reconciliation_required)
      throw new ReconciliationError('task_not_reconciling')
    if (task.kind !== 'queue' || task.request_payload.video)
      throw new ReconciliationError('reconciliation_kind_unsupported', 400)
    const [started] = await tx
      .select()
      .from(schema.operator_audits)
      .where(eq(schema.operator_audits.id, `${auditId}:started`))
    if (started && started.details.digest !== digest)
      throw new ReconciliationError('reconciliation_command_conflict')
    if (task.execution_token && task.lease_expires_at && task.lease_expires_at > Date.now()) {
      if (started)
        return {
          kind: 'replay' as const,
          result: { taskId, status: 'reconciling', reason: 'reconciliation_in_progress' },
        }
      throw new ReconciliationError('reconciliation_busy')
    }
    if (command.action === 'confirm_success' && !validResult(task, command.result, true))
      throw new ReconciliationError('reconciliation_result_required', 400)
    const dispatches = await tx
      .select({ taskId: schema.task_dispatches.upstream_task_id })
      .from(schema.task_dispatches)
      .where(eq(schema.task_dispatches.task_id, taskId))
    const taskIds = [
      ...new Set([
        ...(task.upstream_task_ids ?? []),
        ...dispatches.flatMap((row) => (row.taskId ? [row.taskId] : [])),
      ]),
    ]
    if (command.action !== 'lookup' && taskIds.length) {
      const audits = await tx
        .select({ details: schema.operator_audits.details })
        .from(schema.operator_audits)
        .where(
          and(
            eq(schema.operator_audits.target_id, taskId),
            eq(schema.operator_audits.action, 'task.reconcile'),
          ),
        )
      if (!audits.some((audit) => audit.details.action === 'lookup'))
        throw new ReconciliationError('reconciliation_lookup_required')
    }
    await tx
      .update(schema.tasks)
      .set({ execution_token: token, lease_expires_at: Date.now() + RECONCILIATION_LEASE_MS })
      .where(eq(schema.tasks.id, taskId))
    await tx
      .insert(schema.operator_audits)
      .values({
        id: `${auditId}:started`,
        operator_id: command.operatorId,
        action: 'task.reconcile.started',
        target_type: 'task',
        target_id: taskId,
        created_at: Date.now(),
        details: {
          commandId: command.commandId,
          action: command.action,
          evidence: command.evidence,
          digest,
        },
      })
      .onConflictDoNothing()
    return { kind: 'claimed' as const, task, taskIds }
  })
  if (claim.kind === 'replay') return claim.result
  const { task } = claim
  const owns = () =>
    and(eq(schema.tasks.id, taskId), eq(schema.tasks.status, 'reconciling'), heldBy(token))!
  const controller = new AbortController()
  let renewing = false
  const heartbeat = setInterval(() => {
    if (renewing) return
    renewing = true
    void db
      .update(schema.tasks)
      .set({ lease_expires_at: Date.now() + RECONCILIATION_LEASE_MS })
      .where(owns())
      .returning({ id: schema.tasks.id })
      .then((rows) => {
        if (!rows.length) controller.abort()
      })
      .catch(() => controller.abort())
      .finally(() => {
        renewing = false
      })
  }, RECONCILIATION_HEARTBEAT_MS)
  try {
    let reason: string | undefined
    let update: TerminalTaskUpdate | undefined
    const taskIds = claim.taskIds
    if (command.action === 'confirm_no_result') {
      update = {
        status: 'failed',
        completedAt: Date.now(),
        errorType: 'upstream_no_image',
        errorMessage: '核查确认未产生可交付结果',
      }
    } else {
      let transform: Awaited<ReturnType<typeof protectMaskedOutput>> | undefined
      let checkpoint = command.action === 'lookup' && task.archive_payload
      if (checkpoint && taskIds.length && task.user_id && isCapabilityEnabled('accounts:sync')) {
        try {
          // Recover protected output from saved candidates before depending on the provider's retention.
          let missing = await missingGenerationOutputs(taskId, task.provider, checkpoint)
          if (missing.size && task.request_payload.preserve_outside_mask) {
            const hydrated = await hydrateInputImages(task.request_payload)
            transform = await protectMaskedOutput(
              hydrated.input_images?.[0] ?? '',
              hydrated.mask ?? '',
              task.request_payload.masked_original_size,
            )
            checkpoint = await spoolGenerationOutputs(
              taskId,
              task.provider,
              checkpoint,
              transform,
              controller.signal,
            )
            missing = await missingGenerationOutputs(taskId, task.provider, checkpoint)
          }
          // A successful listing proves loss; storage unavailability must not discard the checkpoint.
          if (missing.size) checkpoint = null
        } catch {
          reason = 'archive_incomplete'
        }
      }
      let payload: unknown = checkpoint || command.result
      if (!reason && command.action === 'lookup' && !checkpoint) {
        if (!taskIds.length) reason = 'manual_verification_required'
        else {
          try {
            payload = (
              await callUpstream({
                provider: task.provider,
                model: task.model,
                request: await hydrateInputImages(task.request_payload),
                reconciliationRequired: true,
                signal: controller.signal,
                resume: {
                  taskIds,
                  invocationCount: task.upstream_invocation_count,
                  submittedAt: 0,
                  pollOnly: true,
                },
                beforeRequest: async () => {
                  throw new Error('reconciliation_cannot_dispatch')
                },
              })
            ).payload
          } catch {
            reason = 'upstream_result_unknown'
          }
        }
      }
      if (!reason) {
        if (!validResult(task, payload, command.action === 'confirm_success'))
          reason = 'manual_verification_required'
        else {
          try {
            if (!transform && task.request_payload.preserve_outside_mask) {
              const hydrated = await hydrateInputImages(task.request_payload)
              transform = await protectMaskedOutput(
                hydrated.input_images?.[0] ?? '',
                hydrated.mask ?? '',
                task.request_payload.masked_original_size,
              )
            }
            const cloud = Boolean(task.user_id && isCapabilityEnabled('accounts:sync'))
            // Each lease owns its output prefix; a late expired operator cannot overwrite a successor's originals.
            const archiveId = checkpoint ? taskId : `${taskId}/reconciliation/${token}`
            const archived = cloud
              ? await spoolGenerationOutputs(
                  archiveId,
                  task.provider,
                  payload,
                  transform,
                  controller.signal,
                )
              : await archiveOutputImages(archiveId, task.provider, payload, transform, {
                  signal: controller.signal,
                  maxBytes: config.operator.quotas['sync:asset-image-bytes'],
                  validateBytes: async (bytes) => {
                    // Decode the actual downloaded/base64 bytes before writing or settling.
                    await sharp(bytes, {
                      limitInputPixels: MEDIA_IMAGE_MAX_PIXELS,
                      failOn: 'warning',
                    }).stats()
                  },
                })
            if (cloud && (await missingGenerationOutputs(archiveId, task.provider, archived)).size)
              throw new Error('archive_checkpoint_incomplete')
            const [stillOwned] = await db
              .select({ id: schema.tasks.id })
              .from(schema.tasks)
              .where(owns())
            if (!stillOwned || controller.signal.aborted)
              throw new ReconciliationError('reconciliation_lease_lost')
            const media = cloud
              ? await archiveGenerationOutputs(
                  task.user_id!,
                  task.provider,
                  archived,
                  task.request_payload,
                )
              : undefined
            update = {
              status: 'completed',
              completedAt: Date.now(),
              resultPayload: archived,
              media,
            }
          } catch {
            reason = 'archive_incomplete'
          }
        }
      }
    }
    return await db.transaction(async (tx) => {
      const [owned] = await tx
        .select({ id: schema.tasks.id })
        .from(schema.tasks)
        .where(owns())
        .for('update')
      if (!owned || controller.signal.aborted)
        throw new ReconciliationError('reconciliation_lease_lost')
      let status: 'reconciling' | 'completed' | 'failed' = 'reconciling'
      if (update) {
        if (!(await finishTask(taskId, update, heldBy(token), { tx })))
          throw new ReconciliationError('reconciliation_lease_lost')
        status = update.status === 'completed' ? 'completed' : 'failed'
      }
      await tx
        .update(schema.tasks)
        .set({ execution_token: null, lease_expires_at: null })
        .where(eq(schema.tasks.id, taskId))
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
          evidence: command.evidence,
          action: command.action,
          digest,
          status,
          ...(reason ? { reason } : {}),
          upstreamTaskIds: taskIds,
        },
      })
      return { taskId, status, ...(reason ? { reason } : {}) }
    })
  } finally {
    clearInterval(heartbeat)
    // Failure leaves the same unresolved task available for another evidence-backed command.
    await db
      .update(schema.tasks)
      .set({ execution_token: null, lease_expires_at: null })
      .where(
        and(
          eq(schema.tasks.id, taskId),
          eq(schema.tasks.status, 'reconciling'),
          eq(schema.tasks.execution_token, token),
        ),
      )
  }
}
