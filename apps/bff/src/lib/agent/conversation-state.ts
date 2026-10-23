import { projectArtifactId } from '@image-playground/shared'
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'

/** 状态摘要只回看这么久：更早的卡片与批次已经不是“刚才那件事”。 */
export const CONVERSATION_STATE_WINDOW_MS = 24 * 60 * 60 * 1000
const MAX_DRAFTS = 10
const MAX_BATCHES = 5
const MAX_NODE_RUNS = 8
const MAX_LISTED_ARTIFACTS = 12
const MAX_LISTED_NODE_IDS = 6

export interface PendingDraftFact {
  readonly title: string
}

export interface PendingNodeRunFact {
  readonly title: string
  readonly nodeIds: readonly string[]
}

export interface BatchFact {
  readonly batchId: string
  readonly title: string
  readonly status: 'draft' | 'cancelled' | 'running' | 'paused' | 'closed'
  readonly itemCount: number
  readonly completed: number
  readonly failed: number
  readonly artifactIds: readonly string[]
}

export interface ConversationStateFacts {
  readonly pendingDrafts: readonly PendingDraftFact[]
  /** 确认门拦下、用户没确认就发了新消息而作废的稿：没提交、没扣费，不再等任何人。 */
  readonly voidedDrafts: readonly PendingDraftFact[]
  readonly pendingNodeRuns: readonly PendingNodeRunFact[]
  readonly batches: readonly BatchFact[]
}

/**
 * 草稿行只记得「还没建任务」，分不出那张卡还在等、已经作废，还是确认门拦着：按同一轮同一次调用的卡认。
 * 作废只改写卡片，草稿行的 `task_id` 照样是空的，单看草稿会把作废的稿当成还在等确认。
 * - 确认门拦下、还在等的卡（`gated` + `awaiting_confirmation`）：智能体本就不知道有这道门，不列；
 * - 作废的卡（`gated` + `failed` + `cancelled`）：草稿行还在，但这次已经了结，单列成「已作废」；
 * - 普通待确认卡、找不到卡的旧数据：照旧算待确认；
 * - 别的终局（已提交、成功、失败）：任务归任务管，这一段不再说它。
 *
 * 一条语句、一个快照里认卡、分类、各取最新 `MAX_DRAFTS` 条：先截条数再分类，较新的作废稿会挤掉更早还在等的卡；
 * 分页跨多条语句又会在读取期间被确认、作废改动结果集。同一张卡出现在多条消息、或同一条消息里出现多次时，按会话内 `seq`、再按块在消息里的位置取最后写的那条。
 */
async function readDraftFacts(
  conversationId: string,
  since: number,
): Promise<{ pendingDrafts: PendingDraftFact[]; voidedDrafts: PendingDraftFact[] }> {
  const rows = (await db.execute(sql`
    WITH classified AS (
      SELECT d.prompt, d.created_at, d.id,
        CASE
          WHEN card.block IS NULL THEN 'pending'
          WHEN card.block->>'status' = 'awaiting_confirmation'
            THEN CASE WHEN card.block->'gated' = 'true'::jsonb THEN 'hidden' ELSE 'pending' END
          WHEN card.block->'gated' = 'true'::jsonb
            AND card.block->>'status' = 'failed'
            AND card.block->>'errorCode' = 'cancelled' THEN 'voided'
          ELSE 'hidden'
        END AS state
      FROM agent_generation_drafts d
      LEFT JOIN LATERAL (
        SELECT b.block
        FROM agent_messages m
        CROSS JOIN LATERAL jsonb_array_elements(m.content) WITH ORDINALITY AS b(block, position)
        WHERE m.conversation_id = d.conversation_id
          AND m.turn_id = d.turn_id
          AND m.role = 'assistant'
          AND m.deleted_at IS NULL
          AND b.block->>'type' = 'toolResult'
          AND b.block->>'toolCallId' = d.tool_call_id
        ORDER BY m.seq DESC, b.position DESC
        LIMIT 1
      ) card ON true
      WHERE d.conversation_id = ${conversationId}
        AND d.task_id IS NULL
        AND d.created_at >= ${new Date(since).toISOString()}::timestamptz
    ), ranked AS (
      SELECT prompt, state, created_at, id,
        row_number() OVER (PARTITION BY state ORDER BY created_at DESC, id DESC) AS rank
      FROM classified
      WHERE state <> 'hidden'
    )
    SELECT prompt, state FROM ranked
    WHERE rank <= ${MAX_DRAFTS}
    ORDER BY created_at DESC, id DESC
  `)) as unknown
  // `db.execute` 不带结果类型：在边界上逐行核对字段，别名或类型变了宁可少列，也不把怪值写进系统事实。
  const valid = (Array.isArray(rows) ? rows : []).filter(
    (row): row is { prompt: string; state: 'pending' | 'voided' } =>
      typeof row === 'object' &&
      row !== null &&
      typeof (row as { prompt?: unknown }).prompt === 'string' &&
      ((row as { state?: unknown }).state === 'pending' ||
        (row as { state?: unknown }).state === 'voided'),
  )
  const pick = (state: 'pending' | 'voided') =>
    valid.filter((row) => row.state === state).map((row) => ({ title: draftTitle(row.prompt) }))
  return { pendingDrafts: pick('pending'), voidedDrafts: pick('voided') }
}

function draftTitle(prompt: string): string {
  const flat = prompt.replace(/\s+/g, ' ').trim()
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat
}

/**
 * 节点运行建议只写在助手消息的工具结果里，服务端看不到用户后来有没有在卡片上点过。
 * 历史 autoRun 和本轮直接出图都已经交给原标签页，不再列进待确认。
 */
function manualNodeRuns(content: unknown): PendingNodeRunFact[] {
  if (!Array.isArray(content)) return []
  const found: PendingNodeRunFact[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const record = block as {
      type?: unknown
      title?: unknown
      canvasRun?: { autoRun?: unknown; direct?: unknown; nodeIds?: unknown }
    }
    if (
      record.type !== 'toolResult' ||
      !record.canvasRun ||
      record.canvasRun.autoRun === true ||
      record.canvasRun.direct === true
    )
      continue
    const nodeIds = Array.isArray(record.canvasRun.nodeIds)
      ? record.canvasRun.nodeIds.filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        )
      : []
    if (!nodeIds.length) continue
    found.push({
      title:
        typeof record.title === 'string' && record.title.trim()
          ? record.title.trim()
          : '建议运行节点',
      nodeIds,
    })
  }
  return found
}

/**
 * 从库里读本会话还挂着的卡片与最近的批次。模型只看历史消息会把“已出完”当成“待执行”，
 * 用户一句“确认”就会把同一件事再提交一遍（2026-10-16 会话 20911719）。
 */
export async function readConversationStateFacts(
  conversationId: string,
  now: number = Date.now(),
): Promise<ConversationStateFacts> {
  const since = now - CONVERSATION_STATE_WINDOW_MS
  const { pendingDrafts, voidedDrafts } = await readDraftFacts(conversationId, since)

  const recentMessages = await db
    .select({ content: schema.agent_messages.content })
    .from(schema.agent_messages)
    .where(
      and(
        eq(schema.agent_messages.conversation_id, conversationId),
        eq(schema.agent_messages.role, 'assistant'),
        isNull(schema.agent_messages.deleted_at),
        gte(schema.agent_messages.created_at, since),
      ),
    )
    .orderBy(desc(schema.agent_messages.created_at))
    .limit(40)

  const batches = await db
    .select({
      id: schema.agent_batches.id,
      status: schema.agent_batches.status,
      version: schema.agent_batches.current_version,
      title: schema.agent_batch_plans.title,
      itemCount: schema.agent_batch_plans.item_count,
    })
    .from(schema.agent_batches)
    .innerJoin(
      schema.agent_batch_plans,
      and(
        eq(schema.agent_batch_plans.batch_id, schema.agent_batches.id),
        eq(schema.agent_batch_plans.version, schema.agent_batches.current_version),
      ),
    )
    .where(
      and(
        eq(schema.agent_batches.conversation_id, conversationId),
        gte(schema.agent_batches.updated_at, since),
      ),
    )
    .orderBy(desc(schema.agent_batches.updated_at))
    .limit(MAX_BATCHES)

  const outcomes = batches.length
    ? await db
        .select({
          batchId: schema.agent_batch_attempts.batch_id,
          taskId: schema.tasks.id,
          status: schema.tasks.status,
        })
        .from(schema.agent_batch_attempts)
        .innerJoin(schema.tasks, eq(schema.tasks.id, schema.agent_batch_attempts.task_id))
        .where(
          inArray(
            schema.agent_batch_attempts.batch_id,
            batches.map((batch) => batch.id),
          ),
        )
        .orderBy(sql`${schema.agent_batch_attempts.submitted_at} ASC`)
    : []

  return {
    pendingDrafts,
    voidedDrafts,
    pendingNodeRuns: recentMessages
      .flatMap((message) => manualNodeRuns(message.content))
      .slice(0, MAX_NODE_RUNS),
    batches: batches.map((batch) => {
      const mine = outcomes.filter((outcome) => outcome.batchId === batch.id)
      const done = mine.filter((outcome) => outcome.status === 'completed')
      return {
        batchId: batch.id,
        title: batch.title,
        status: batch.status,
        itemCount: batch.itemCount,
        completed: done.length,
        failed: mine.filter((outcome) => outcome.status === 'failed').length,
        artifactIds: done.map((outcome) => projectArtifactId(outcome.taskId, 0)),
      }
    }),
  }
}

function batchLine(batch: BatchFact): string {
  const head = `批次 ${batch.batchId}「${batch.title}」`
  switch (batch.status) {
    case 'draft':
      return `${head}：计划待用户在卡片上确认，尚未提交，未扣费`
    case 'cancelled':
      return `${head}：已取消`
    case 'running':
      return `${head}：执行中，已完成 ${batch.completed}/${batch.itemCount}`
    case 'paused':
      return `${head}：已暂停，已完成 ${batch.completed}/${batch.itemCount}`
    case 'closed': {
      const listed = batch.artifactIds.slice(0, MAX_LISTED_ARTIFACTS)
      const more = batch.artifactIds.length - listed.length
      const failed = batch.failed ? `，失败 ${batch.failed}` : ''
      const artifacts = listed.length
        ? `；产物：${listed.join('、')}${more > 0 ? ` 等 ${batch.artifactIds.length} 张` : ''}`
        : ''
      return `${head}：已执行完毕，完成 ${batch.completed}/${batch.itemCount}${failed}${artifacts}`
    }
  }
}

/** 没有挂着的卡片也没有最近的批次时不出这一段，免得每轮都多一块空话。 */
function nodeRunLine(run: PendingNodeRunFact): string {
  const listed = run.nodeIds.slice(0, MAX_LISTED_NODE_IDS)
  const more = run.nodeIds.length - listed.length
  const extra = more > 0 ? ` 等 ${run.nodeIds.length} 个` : ''
  return `「${run.title}」节点 ${listed.join('、')}${extra}`
}

export function renderConversationState(facts: ConversationStateFacts): string | undefined {
  if (
    !facts.pendingDrafts.length &&
    !facts.voidedDrafts.length &&
    !facts.pendingNodeRuns.length &&
    !facts.batches.length
  )
    return undefined
  const lines = ['（系统事实，不是用户说的话）本会话当前状态：']
  if (facts.pendingDrafts.length)
    lines.push(
      `- 待用户在卡片上确认的生成 ${facts.pendingDrafts.length} 张（尚未提交，未扣费）：${facts.pendingDrafts
        .map((draft) => `「${draft.title}」`)
        .join('、')}`,
    )
  if (facts.voidedDrafts.length)
    lines.push(
      `- 已作废的生成 ${facts.voidedDrafts.length} 张（没有提交任务，也没有扣费；不在等确认，不要说它还在卡片上等确认）：${facts.voidedDrafts
        .map((draft) => `「${draft.title}」`)
        .join('、')}`,
    )
  if (facts.pendingNodeRuns.length)
    lines.push(
      `- 待用户在卡片上确认的节点运行 ${facts.pendingNodeRuns.length} 组（尚未提交，未扣费）：${facts.pendingNodeRuns
        .map(nodeRunLine)
        .join('；')}`,
    )
  for (const batch of facts.batches) lines.push(`- ${batchLine(batch)}`)
  lines.push(
    '用户只说“确认”“可以”“执行”“开始生成”这类话时，先对照上面的状态：要做的事已经执行完毕，就告诉用户已经出完并指出产物；还有待确认的生成卡、节点运行卡或计划，就提示用户在卡片上点确认。不要为这类话重新调用生成工具、runNodes 或重新拟同一份计划。还有待确认卡片时，回复结尾写明还剩几张生成或几组节点等用户确认。若画布上这些节点已经在生成或已完成，改为说明当前结果，不要再催确认。',
  )
  return lines.join('\n')
}

export async function conversationStateNote(
  conversationId: string,
  now: number = Date.now(),
): Promise<string | undefined> {
  return renderConversationState(await readConversationStateFacts(conversationId, now))
}
