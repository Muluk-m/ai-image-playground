import { hostname } from 'node:os'
import { and, eq, gt, lt, ne, or } from 'drizzle-orm'
import { config } from '../../config'
import { db, schema } from '../../db/client'
import { log } from '../logger'
import type { BffTransaction } from '../private-overlay'

export const agentInstance = `${hostname()}:${crypto.randomUUID()}`
export const AGENT_EXECUTION_LEASE_MS = 30_000

export class ConversationExecutionLost extends Error {
  constructor() {
    super('Conversation execution ownership lost')
    this.name = 'ConversationExecutionLost'
  }
}

export function agentExecutionToken(turnId: string): string {
  return `agent:${agentInstance}:${turnId}`
}

/**
 * Locks the durable ownership row for the whole callback. A stale executor therefore cannot pass
 * the ownership check and then write after a replacement claim commits.
 */
export async function withConversationExecution<T>(
  conversationId: string,
  turnId: string,
  callback: (tx: BffTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const now = Date.now()
    const [owned] = await tx
      .update(schema.agent_executions)
      .set({ heartbeat_at: now })
      .where(
        and(
          eq(schema.agent_executions.conversation_id, conversationId),
          eq(schema.agent_executions.turn_id, turnId),
          eq(schema.agent_executions.instance, agentInstance),
          eq(schema.agent_executions.state, 'running'),
        ),
      )
      .returning({ id: schema.agent_executions.turn_id })
    if (!owned) throw new ConversationExecutionLost()
    await tx
      .update(schema.tasks)
      .set({ lease_expires_at: now + AGENT_EXECUTION_LEASE_MS })
      .where(
        and(
          eq(schema.tasks.kind, 'chat'),
          eq(schema.tasks.agent_conversation_id, conversationId),
          eq(schema.tasks.agent_turn_id, turnId),
          eq(schema.tasks.execution_token, agentExecutionToken(turnId)),
          eq(schema.tasks.status, 'in_progress'),
        ),
      )
    return callback(tx)
  })
}

export async function assertConversationExecution(
  conversationId: string,
  turnId: string,
): Promise<void> {
  await withConversationExecution(conversationId, turnId, async () => {})
}

export async function conversationExecution(conversationId: string) {
  const [row] = await db
    .select()
    .from(schema.agent_executions)
    .where(
      and(
        eq(schema.agent_executions.conversation_id, conversationId),
        eq(schema.agent_executions.state, 'running'),
        gt(schema.agent_executions.heartbeat_at, Date.now() - AGENT_EXECUTION_LEASE_MS),
      ),
    )
  return row
}

export async function claimConversation(conversationId: string, turnId: string): Promise<boolean> {
  const now = Date.now()
  const values = {
    conversation_id: conversationId,
    turn_id: turnId,
    instance: agentInstance,
    origin: config.execution.origin,
    state: 'running' as const,
    heartbeat_at: now,
  }
  const rows = await db
    .insert(schema.agent_executions)
    .values(values)
    .onConflictDoUpdate({
      target: schema.agent_executions.conversation_id,
      set: values,
      where: or(
        ne(schema.agent_executions.state, 'running'),
        lt(schema.agent_executions.heartbeat_at, now - AGENT_EXECUTION_LEASE_MS),
      ),
    })
    .returning({ id: schema.agent_executions.turn_id })
  return rows.length > 0
}

export async function releaseConversation(conversationId: string, turnId: string) {
  await db
    .update(schema.agent_executions)
    .set({ state: 'completed' })
    .where(
      and(
        eq(schema.agent_executions.conversation_id, conversationId),
        eq(schema.agent_executions.turn_id, turnId),
        eq(schema.agent_executions.instance, agentInstance),
      ),
    )
}

/** Called only after authorizing the conversation; the destination is registered by our executor. */
export async function forwardActiveTurn(
  conversationId: string,
  request: Request,
  body?: unknown,
): Promise<Response | undefined> {
  const owner = await conversationExecution(conversationId)
  if (owner?.instance === agentInstance) return
  let origin = owner?.origin
  if (!owner && config.execution.legacyOrigin) {
    const [conversation] = await db
      .select({ generation: schema.agent_conversations.runtime_generation })
      .from(schema.agent_conversations)
      .where(eq(schema.agent_conversations.id, conversationId))
    if (conversation?.generation === 0) origin = config.execution.legacyOrigin
  }
  if (!owner && !origin) return
  if (!origin || request.headers.has('x-agent-forwarded'))
    return Response.json({ error: 'turn_owner_unavailable' }, { status: 503 })
  const url = new URL(request.url)
  const headers = new Headers(request.headers)
  headers.delete('host')
  headers.delete('content-length')
  headers.set('x-agent-forwarded', '1')
  const connecting = new AbortController()
  const timer = setTimeout(() => connecting.abort(), 15_000)
  try {
    return await fetch(`${origin}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.any([request.signal, connecting.signal]),
    })
  } catch {
    return Response.json({ error: 'turn_owner_unavailable' }, { status: 503 })
  } finally {
    clearTimeout(timer)
  }
}

export function maintainConversation(conversationId: string, turnId: string, lost: () => void) {
  let pending = false
  const timer = setInterval(async () => {
    if (pending) return
    pending = true
    try {
      await assertConversationExecution(conversationId, turnId)
    } catch (err) {
      log.error(
        { event: 'agent.execution_heartbeat_failed', turnId, err },
        'agent execution heartbeat failed',
      )
      lost()
    } finally {
      pending = false
    }
  }, 10_000)
  return () => clearInterval(timer)
}
