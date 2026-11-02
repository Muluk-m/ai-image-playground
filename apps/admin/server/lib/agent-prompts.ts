import { type QueueProvider, unshapeQueuePrompt } from '@image-playground/shared'
import { sql } from 'drizzle-orm'
import type { AgentPromptFilters, AgentPromptItem, AgentPromptsResult } from '../../contracts'
import { getDbHandle } from './db'

type Row = Record<string, unknown>
const PAGE_SIZE = 50
const text = (value: unknown) => (value == null ? null : String(value))
const epoch = (value: unknown) =>
  value instanceof Date ? value.getTime() : Date.parse(String(value))
export class AgentPromptQueryError extends Error {}

function decodeCursor(value?: string) {
  if (!value) return null
  try {
    const data = JSON.parse(Buffer.from(value, 'base64url').toString())
    if (
      !Array.isArray(data) ||
      data.length !== 3 ||
      !Number.isSafeInteger(data[0]) ||
      data[0] < 0 ||
      !['draft', 'task'].includes(data[1]) ||
      typeof data[2] !== 'string' ||
      !data[2] ||
      data[2].length > 200
    )
      throw new Error()
    const at = new Date(data[0])
    if (!Number.isFinite(at.getTime())) throw new Error()
    return { at, kind: data[1] as string, id: data[2] as string }
  } catch {
    throw new AgentPromptQueryError('无效的分页游标')
  }
}

export async function getAgentPrompts(
  filters: AgentPromptFilters,
  cursorValue?: string,
): Promise<AgentPromptsResult> {
  const cursor = decodeCursor(cursorValue)
  const { db } = getDbHandle()
  const from = new Date(filters.from)
  const to = new Date(filters.to)
  const source = sql`
    WITH raw_prompts AS (
      SELECT d.id, 'draft'::text AS kind, d.created_at, d.conversation_id, d.turn_id,
        d.tool_call_id, COALESCE(d.tool_call_id, d.id) AS group_key,
        d.prompt, d.drafted_prompt, d.drafted_prompt IS DISTINCT FROM d.prompt AS changed,
        d.drafted_prompt IS NOT NULL AS known_original,
        d.tool_name AS tool, d.media, d.model, d.provider, NULL::text AS size,
        d.task_id, CASE WHEN d.task_id IS NULL THEN 'awaiting'
          WHEN t.status = 'completed' THEN 'completed' WHEN t.status IN ('failed', 'cancelled') THEN 'failed'
          ELSE 'running' END AS status
      FROM agent_generation_drafts d LEFT JOIN queue_tasks t ON t.id = d.task_id
      WHERE d.created_at >= ${from} AND d.created_at <= ${to}
      UNION ALL
      SELECT t.id, 'task', t.submitted_at, t.agent_conversation_id, t.agent_turn_id,
        j.tool_call_id, COALESCE(j.tool_call_id, t.id) AS group_key,
        COALESCE(t.request_payload->>'prompt', ''), NULL, false, true,
        NULL::text,
        CASE WHEN t.request_payload->'video' IS NOT NULL THEN 'video' ELSE 'image' END,
        t.model, t.provider, t.request_payload->>'size', t.id,
        CASE WHEN t.status = 'completed' THEN 'completed' WHEN t.status IN ('failed', 'cancelled') THEN 'failed'
          ELSE 'running' END
      FROM queue_tasks t
      LEFT JOIN agent_jobs j ON j.task_id = t.id
      WHERE t.agent_conversation_id IS NOT NULL
        AND t.submitted_at >= ${from} AND t.submitted_at <= ${to}
        AND NOT EXISTS (SELECT 1 FROM agent_generation_drafts d WHERE d.task_id = t.id)
    ), prompts AS (
      SELECT (array_agg(r.id ORDER BY r.created_at, r.id))[1] AS id,
        CASE WHEN COUNT(*) FILTER (WHERE r.kind = 'draft') > 0 THEN 'draft' ELSE 'task' END::text AS kind,
        MIN(r.created_at) AS created_at, r.conversation_id, r.turn_id,
        (array_agg(r.tool_call_id ORDER BY r.created_at, r.id))[1] AS tool_call_id,
        r.group_key,
        (array_agg(r.prompt ORDER BY r.created_at, r.id))[1] AS prompt,
        (array_agg(r.drafted_prompt ORDER BY r.created_at, r.id))[1] AS drafted_prompt,
        BOOL_OR(r.changed) AS changed, BOOL_OR(r.known_original) AS known_original,
        (array_agg(r.tool ORDER BY r.created_at, r.id))[1] AS tool,
        (array_agg(r.media ORDER BY r.created_at, r.id))[1] AS media,
        (array_agg(r.model ORDER BY r.created_at, r.id))[1] AS model,
        (array_agg(r.provider ORDER BY r.created_at, r.id))[1] AS provider,
        (array_agg(r.size ORDER BY r.created_at, r.id))[1] AS size,
        (array_agg(r.task_id ORDER BY r.created_at, r.id) FILTER (WHERE r.task_id IS NOT NULL))[1] AS task_id,
        array_agg(r.task_id ORDER BY r.created_at, r.id) FILTER (WHERE r.task_id IS NOT NULL) AS task_ids,
        CASE WHEN BOOL_OR(r.status = 'running') THEN 'running'
          WHEN BOOL_OR(r.status = 'awaiting') THEN 'awaiting'
          WHEN BOOL_OR(r.status = 'failed') THEN 'failed'
          ELSE 'completed' END AS status
      FROM raw_prompts r
      GROUP BY r.conversation_id, r.turn_id, r.group_key
    ), filtered AS (
      SELECT p.*, c.user_id, c.device_id, u.username
      FROM prompts p JOIN agent_conversations c ON c.id = p.conversation_id
      LEFT JOIN users u ON u.id = c.user_id
      WHERE ${filters.taskId ? sql`${filters.taskId} = ANY(p.task_ids)` : sql`true`}
        AND ${filters.status ? sql`p.status = ${filters.status}` : sql`true`}
        AND ${filters.userId ? sql`c.user_id = ${filters.userId}` : sql`true`}
        AND ${filters.deviceId ? sql`c.device_id = ${filters.deviceId}` : sql`true`}
        AND ${
          filters.edited === 'unknown'
            ? sql`NOT p.known_original`
            : filters.edited
              ? sql`p.known_original AND p.changed = ${filters.edited === 'true'}`
              : sql`true`
        }
        AND ${
          filters.q
            ? sql`(p.prompt ILIKE ${`%${filters.q.replace(/[\\%_]/g, '\\$&')}%`}
          OR p.drafted_prompt ILIKE ${`%${filters.q.replace(/[\\%_]/g, '\\$&')}%`})`
            : sql`true`
        }
    )`
  const [raw, totals] = await Promise.all([
    db.execute(sql`${source} SELECT * FROM filtered
      WHERE ${
        cursor
          ? sql`(created_at < ${cursor.at} OR (created_at = ${cursor.at}
        AND (kind > ${cursor.kind} OR (kind = ${cursor.kind} AND id > ${cursor.id}))))`
          : sql`true`
      }
      ORDER BY created_at DESC, kind, id LIMIT ${PAGE_SIZE + 1}`),
    cursor
      ? Promise.resolve(null)
      : db.execute(sql`${source}
      SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE known_original) AS known_original,
        COUNT(*) FILTER (WHERE known_original AND changed) AS edited,
        COUNT(*) FILTER (WHERE status = 'awaiting') AS awaiting,
        COUNT(*) FILTER (WHERE task_id IS NOT NULL) AS submitted,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed FROM filtered`),
  ])
  const rows = (raw as unknown as Row[]).slice(0, PAGE_SIZE)
  // Context is fetched only for the current page, and only text blocks leave the database.
  const pairs = sql.join(
    rows.map((row) => sql`(${row.conversation_id}, ${row.turn_id})`),
    sql`, `,
  )
  const [messages, calls, taskTools] = rows.length
    ? await Promise.all([
        db.execute(sql`SELECT m.conversation_id, m.turn_id,
      string_agg(b.block->>'text', E'\n' ORDER BY m.seq, b.ordinality) AS user_text
      FROM agent_messages m CROSS JOIN LATERAL jsonb_array_elements(m.content) WITH ORDINALITY AS b(block, ordinality)
      WHERE (m.conversation_id, m.turn_id) IN (${pairs}) AND m.role = 'user'
        AND m.deleted_at IS NULL AND b.block->>'type' = 'text'
      GROUP BY m.conversation_id, m.turn_id`),
        db.execute(sql`SELECT conversation_id, turn_id,
      (array_agg(model ORDER BY started_at, id))[1] AS model,
      COALESCE(SUM(CASE WHEN usage->>'inputTokens' ~ '^[0-9]{1,15}$'
        THEN (usage->>'inputTokens')::bigint ELSE 0 END), 0) AS input_tokens,
      COALESCE(SUM(CASE WHEN usage->>'outputTokens' ~ '^[0-9]{1,15}$'
        THEN (usage->>'outputTokens')::bigint ELSE 0 END), 0) AS output_tokens
      FROM agent_model_calls WHERE (conversation_id, turn_id) IN (${pairs}) AND purpose = 'conversation'
      GROUP BY conversation_id, turn_id`),
        db.execute(sql`SELECT DISTINCT ON (j.task_id) j.task_id, c.tool_name
      FROM agent_jobs j JOIN agent_tool_calls c ON c.conversation_id = j.conversation_id
        AND c.turn_id = j.turn_id AND c.tool_call_id = j.tool_call_id
      WHERE j.task_id IN (${sql.join(
        rows.map((row) => sql`${row.task_id}`),
        sql`, `,
      )})
      ORDER BY j.task_id, c.created_at, c.message_id`),
      ])
    : [[], [], []]
  const key = (row: Row) => JSON.stringify([row.conversation_id, row.turn_id])
  const messageMap = new Map((messages as unknown as Row[]).map((row) => [key(row), row]))
  const callMap = new Map((calls as unknown as Row[]).map((row) => [key(row), row]))
  const toolMap = new Map(
    (taskTools as unknown as Row[]).map((row) => [row.task_id, row.tool_name]),
  )
  const items = rows.map((row): AgentPromptItem => {
    const call = callMap.get(key(row))
    const prompt =
      row.kind === 'task' && row.media !== 'video'
        ? unshapeQueuePrompt({
            prompt: String(row.prompt),
            size: text(row.size) ?? undefined,
            provider: row.provider as QueueProvider,
          })
        : String(row.prompt)
    const original = row.kind === 'task' ? prompt : text(row.drafted_prompt)
    return {
      id: String(row.id),
      kind: row.kind as AgentPromptItem['kind'],
      createdAt: epoch(row.created_at),
      conversationId: String(row.conversation_id),
      turnId: text(row.turn_id),
      userId: text(row.user_id),
      deviceId: text(row.device_id),
      username: text(row.username),
      prompt,
      draftedPrompt: original,
      edited: original === null ? null : original !== prompt,
      status: row.status as AgentPromptItem['status'],
      tool: text(row.tool) ?? text(toolMap.get(row.task_id)) ?? '未记录',
      media: String(row.media),
      model: String(row.model),
      taskId: text(row.task_id),
      groupId: text(row.group_key),
      taskIds: Array.isArray(row.task_ids)
        ? row.task_ids.filter((id): id is string => id != null).map(String)
        : [],
      userText: text(messageMap.get(key(row))?.user_text),
      chatModel: text(call?.model),
      inputTokens: Number(call?.input_tokens ?? 0),
      outputTokens: Number(call?.output_tokens ?? 0),
    }
  })
  const total = (totals as unknown as Row[] | null)?.[0]
  const last = items.at(-1)
  return {
    items,
    window: { from: filters.from, to: filters.to },
    summary: total
      ? {
          total: Number(total.total),
          knownOriginal: Number(total.known_original),
          edited: Number(total.edited),
          awaiting: Number(total.awaiting),
          submitted: Number(total.submitted),
          failed: Number(total.failed),
        }
      : null,
    nextCursor:
      raw.length > PAGE_SIZE && last
        ? Buffer.from(JSON.stringify([last.createdAt, last.kind, last.id])).toString('base64url')
        : null,
  }
}
