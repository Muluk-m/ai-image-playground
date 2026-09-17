import { type DbHandle, schema } from '@image-playground/db'
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
      .where(
        and(
          inArray(schema.tasks.id, taskIds.slice(offset, offset + TASK_BATCH_SIZE)),
          isNotNull(schema.tasks.user_id),
          eq(schema.tasks.kind, 'queue'),
          sql`${schema.tasks.request_payload} -> 'video' IS NULL`,
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
          (id, user_id, provider, model, status, prompt, parameters, actual_parameters, created_at, started_at, completed_at, revision)
        SELECT id, user_id, provider, model, status, request_payload ->> 'prompt',
          jsonb_strip_nulls(jsonb_build_object('size', request_payload -> 'size','quality', request_payload -> 'quality','output_format', request_payload -> 'output_format','output_compression', request_payload -> 'output_compression','moderation', request_payload -> 'moderation','aspect_ratio', request_payload -> 'aspect_ratio','image_size', request_payload -> 'image_size','thinking_level', request_payload -> 'thinking_level','n', request_payload -> 'n')),
          jsonb_strip_nulls(jsonb_build_object('size', result_payload -> 'size', 'quality', result_payload -> 'quality', 'output_format', result_payload -> 'output_format')),
          submitted_at, started_at, completed_at, ${head!.sequence.toString()}::bigint
        FROM ${schema.tasks}
        WHERE ${schema.tasks.user_id} = ${userId}
          AND ${inArray(schema.tasks.id, ids.slice(offset, offset + TASK_BATCH_SIZE))}
        ON CONFLICT (id) DO UPDATE SET status = excluded.status,
          started_at = excluded.started_at, completed_at = excluded.completed_at,
          revision = excluded.revision, parameters = excluded.parameters, actual_parameters = excluded.actual_parameters
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
