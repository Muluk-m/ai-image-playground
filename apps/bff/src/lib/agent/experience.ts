import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import type { BffTransaction } from '../private-overlay'
import type { AgentTurnSource } from './turn-preparation'

type AgentExperience = 'chat' | 'canvas'

function ownedProject(conversationId: string, userId: string) {
  return and(
    eq(schema.canvas_projects.conversation_id, conversationId),
    eq(schema.canvas_projects.user_id, userId),
    isNull(schema.canvas_projects.deleted_at),
  )
}

/**
 * 项目文档记下的入口是权威来源；没记下时只认当前消息或原轮已消费的消息。
 *
 * 文档缺 `experience` 的是这个字段出现之前建的项目。客户端按「绑会话之前、有内容就是画布」
 * 推断它，绑上会话的那一刻推断就失效了，所以服务端不能照抄那条规则补默认值——那样画布里
 * 发出的第一句话会被当成对话，模型拿不到画布工具。客户端在画布视图里发话才带画布快照，
 * 这就是它当时看到的入口；消息真正被这一轮取走时由 `recordAgentExperience` 记到项目上。
 */
export async function loadAgentExperience(
  conversationId: string,
  userId: string | null,
  source: AgentTurnSource,
): Promise<{ experience: AgentExperience; unrecorded: boolean }> {
  let unrecorded = false
  if (userId) {
    const [project] = await db
      .select({ document: schema.canvas_projects.document })
      .from(schema.canvas_projects)
      .where(ownedProject(conversationId, userId))
      .limit(1)
    if (project?.document.experience) return { experience: project.document.experience, unrecorded }
    unrecorded = Boolean(project)
  }
  if (source.kind === 'message')
    return { experience: messageExperience(source.message), unrecorded }
  return { experience: await originExperience(conversationId, source), unrecorded: false }
}

/**
 * 一条用户消息自己说的入口。新客户端直接声明它看到的入口；老客户端只在画布视图里带画布快照，
 * 有快照就是画布。快照会因画布还在加载而缺席，所以声明优先。
 */
function messageExperience(message: {
  readonly experience?: AgentExperience
  readonly canvas?: unknown
}): AgentExperience {
  return message.experience ?? (message.canvas ? 'canvas' : 'chat')
}

/** 唤醒与续跑沿已消费的来源追到发起它的用户消息；追不到就按对话算，这个猜测不记到项目上。 */
async function originExperience(
  conversationId: string,
  source: Exclude<AgentTurnSource, { kind: 'message' }>,
): Promise<AgentExperience> {
  if (source.kind === 'resume' && source.resume.canvas) return 'canvas'
  let originTurnId =
    source.kind === 'wake'
      ? source.wake.turnId
      : (source.resume.wake?.turnId ?? source.resume.interruptedTurnId)
  const visited = new Set<string>()
  // 任务可能由上一轮唤醒里的后续编辑提交；沿已消费的来源追到用户消息，不能读队尾。
  while (!visited.has(originTurnId)) {
    visited.add(originTurnId)
    const rows = await db
      .select({ payload: schema.agent_inbox.payload })
      .from(schema.agent_inbox)
      .where(
        and(
          eq(schema.agent_inbox.conversation_id, conversationId),
          eq(schema.agent_inbox.status, 'consumed'),
          eq(schema.agent_inbox.consumed_turn_id, originTurnId),
        ),
      )
      .orderBy(desc(schema.agent_inbox.seq))
    const origin = rows.find((row) => 'text' in row.payload) ?? rows[0]
    if (!origin) break
    const payload = origin.payload
    if ('text' in payload) return messageExperience(payload)
    if ('canvas' in payload && payload.canvas) return 'canvas'
    if ('interruptedTurnId' in payload)
      originTurnId = payload.wake?.turnId ?? payload.interruptedTurnId
    else originTurnId = payload.turnId
  }
  return 'chat'
}

/**
 * 把用户消息判定出的入口记到还没记过的项目上，之后两边都以它为准。返回项目此刻的入口是否
 * 与这一轮用的一致。
 *
 * 必须在取走这条消息的同一事务里调：消息被撤回、预扣失败时整笔回滚，入口也不该被定下。
 * 锁与项目保存（`lib/projects.ts` 的 `writeProject`）同一把所有者行锁，保存读到旧文档、
 * 再整份写回时不会把这里刚补上的值冲掉；只补空着的那格，revision 不动，保存时沿用已有的值。
 * 保存不受会话租约约束，可能抢在这里之前先定下入口：那时这一轮是按过期的判断准备的，不一致。
 */
export async function recordAgentExperience(
  tx: BffTransaction,
  conversationId: string,
  userId: string,
  experience: AgentExperience,
): Promise<boolean> {
  await tx
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .for('update')
  const [project] = await tx
    .select({ document: schema.canvas_projects.document })
    .from(schema.canvas_projects)
    .where(ownedProject(conversationId, userId))
    .limit(1)
  if (!project) return true
  if (project.document.experience) return project.document.experience === experience
  await tx
    .update(schema.canvas_projects)
    .set({
      document: sql`jsonb_set(${schema.canvas_projects.document}, '{experience}', to_jsonb(${experience}::text))`,
    })
    .where(ownedProject(conversationId, userId))
  return true
}
