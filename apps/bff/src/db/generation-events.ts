import { type DbHandle, resolvedTaskRequestPayload, schema } from '@image-playground/db'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'

type Transaction = Parameters<Parameters<DbHandle['db']['transaction']>[0]>[0]
const TASK_BATCH_SIZE = 500

/** Acquire account sequences last, after task and billing locks; hold them until commit. */
export async function publishGenerations(tx: Transaction, taskIds: string[]) {
  const owners = new Map<string, string[]>()
  for (let offset = 0; offset < taskIds.length; offset += TASK_BATCH_SIZE) {
    const tasks = await tx
      .select({ id: schema.tasks.id, userId: schema.tasks.user_id })
      .from(schema.tasks)
      .leftJoin(schema.task_payloads, eq(schema.task_payloads.task_id, schema.tasks.id))
      .where(
        and(
          inArray(schema.tasks.id, taskIds.slice(offset, offset + TASK_BATCH_SIZE)),
          isNotNull(schema.tasks.user_id),
          eq(schema.tasks.kind, 'queue'),
          sql`${resolvedTaskRequestPayload} -> 'video' IS NULL`,
          // 画布候选只活在队列里，不进作品列表。已经写过的旧行由列表查询排除。
          sql`${resolvedTaskRequestPayload} ->> 'output_retention' IS DISTINCT FROM 'candidate'`,
        ),
      )
    for (const task of tasks) {
      const ids = owners.get(task.userId!) ?? []
      ids.push(task.id)
      owners.set(task.userId!, ids)
    }
  }
  for (const userId of [...owners.keys()].sort()) {
    const ids = owners.get(userId)!
    await tx.insert(schema.user_change_heads).values({ user_id: userId }).onConflictDoNothing()
    const [head] = await tx
      .update(schema.user_change_heads)
      .set({ sequence: sql`${schema.user_change_heads.sequence} + 1` })
      .where(eq(schema.user_change_heads.user_id, userId))
      .returning()
    // Keep prompts and result payloads inside PostgreSQL instead of copying them through the worker.
    for (let offset = 0; offset < ids.length; offset += TASK_BATCH_SIZE) {
      await tx.execute(sql`
        INSERT INTO ${schema.generation_records}
          (id, user_id, provider, model, status, archive_status, error_type, prompt, parameters, actual_parameters, created_at, started_at, completed_at, revision, source)
        SELECT ${schema.tasks.id}, ${schema.tasks.user_id}, ${schema.tasks.provider}, ${schema.tasks.model}, ${schema.tasks.status},
          CASE WHEN ${schema.tasks.status} IN ('queued', 'in_progress') AND payload.archive_payload IS NOT NULL THEN 'pending'
            WHEN ${schema.tasks.status} = 'failed' AND ${schema.tasks.error_type} = 'upstream_result_unknown' THEN 'unavailable'
            WHEN ${schema.tasks.status} = 'completed' AND EXISTS (SELECT 1 FROM generation_images WHERE generation_id = ${schema.tasks.id} AND role = 'output') THEN 'ready'
            ELSE 'none' END,
          ${schema.tasks.error_type}, payload.request_payload ->> 'prompt',
          jsonb_strip_nulls(jsonb_build_object('no_rewrite', payload.request_payload -> 'no_rewrite','size', payload.request_payload -> 'size','quality', payload.request_payload -> 'quality','output_format', payload.request_payload -> 'output_format','output_compression', payload.request_payload -> 'output_compression','moderation', payload.request_payload -> 'moderation','aspect_ratio', payload.request_payload -> 'aspect_ratio','image_size', payload.request_payload -> 'image_size','thinking_level', payload.request_payload -> 'thinking_level','n', payload.request_payload -> 'n','frame_count', payload.request_payload -> 'frame_count','frame_duration_ms', payload.request_payload -> 'frame_duration_ms')),
          jsonb_strip_nulls(jsonb_build_object('size', payload.result_payload -> 'size', 'quality', payload.result_payload -> 'quality', 'output_format', payload.result_payload -> 'output_format')),
          ${schema.tasks.submitted_at}, ${schema.tasks.started_at}, ${schema.tasks.completed_at}, ${head!.sequence.toString()}::bigint,
          CASE WHEN ${schema.tasks.agent_conversation_id} IS NOT NULL AND ${schema.tasks.agent_turn_id} IS NOT NULL THEN
            jsonb_build_object('kind', 'agent', 'conversationId', ${schema.tasks.agent_conversation_id},
              'turnId', ${schema.tasks.agent_turn_id}, 'projectId', (SELECT project_id FROM project_generation_outputs
                WHERE generation_id = ${schema.tasks.id} AND user_id = ${schema.tasks.user_id} LIMIT 1))
          WHEN payload.request_payload ->> 'output_retention' = 'canvas' THEN jsonb_build_object('kind', 'canvas')
          ELSE jsonb_build_object('kind', 'studio') END
        FROM ${schema.tasks}
        INNER JOIN ${schema.task_payloads} payload ON payload.task_id = ${schema.tasks.id}
        WHERE ${schema.tasks.user_id} = ${userId}
          AND ${inArray(schema.tasks.id, ids.slice(offset, offset + TASK_BATCH_SIZE))}
        ON CONFLICT (id) DO UPDATE SET status = excluded.status,
          started_at = excluded.started_at, completed_at = excluded.completed_at,
          revision = excluded.revision, parameters = excluded.parameters, actual_parameters = excluded.actual_parameters, archive_status = excluded.archive_status, error_type = excluded.error_type
      `)
    }
    const changes = ids.map((id) => ({ entity: 'generation' as const, id }))
    await tx.insert(schema.user_changes).values({
      user_id: userId,
      sequence: head!.sequence,
      changes:
        Buffer.byteLength(JSON.stringify(changes)) > 60 * 1024
          ? [{ entity: 'generation', invalidate: true }]
          : changes,
      created_at: Date.now(),
    })
  }
}
