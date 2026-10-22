import type { AgentDraftSubmission } from '@image-playground/db'
import type {
  AgentBackgroundJob,
  AgentContentBlock,
  AgentMessageView,
  AgentToolErrorCode,
  AgentToolName,
  AgentToolResultBlock,
  ChannelMedia,
  PersistedSubmitRequest,
  PersistedVideoRequest,
  QueueProvider,
  SubmitRequest,
} from '@image-playground/shared'
import {
  AGENT_CONFIRMATION_PROMPT_MAX_CHARS,
  agentTitleLine,
  unshapeQueuePrompt,
} from '@image-playground/shared'
import { and, eq, isNull, or, sql } from 'drizzle-orm'
import { db, schema } from '../../db/client'
import { resolveQueueModel } from '../channels'
import { archiveInputImages, hydrateInputImages, ObjectStorageError } from '../imageArchive'
import { log } from '../logger'
import { objectStore } from '../objectStore'
import type { BffTransaction } from '../private-overlay'
import { lockMediaOwner } from '../projectMedia'
import { createQueueTask } from '../taskSubmission'
import type { AgentOwner } from './conversations'
import { enqueueAgentResume, gateResumeLive, userMessageSince } from './inbox'
import {
  validateImageParameters,
  validateProductionConfirmation,
} from './production-generation-validation'
import { shapeQueuePrompt } from './prompt-shaping'
import {
  GATE_VOIDED_MESSAGE,
  isPendingGate,
  pendingGateMessages,
  turnHasPendingGate,
} from './tool-gate-records'
import { AgentToolError, queueRefusalCode } from './tools/errors'
import { agentVideoRequestError } from './video-models'

/**
 * 生成前的确认：模型只拟稿，钱由用户按下「确认生成」才花。
 *
 * 工具把一次生成要的全部材料准备到位（提示词、输入图、遮罩、模型、档位）却不提交，材料落进
 * `agent_generation_drafts`，卡片以 `awaiting_confirmation` 呈现在对话里。用户可以改提示词——模型把
 * 「浅灰绿色」写进白色浴缸的那种事，在这一步就改得回来——改完确认，服务端照这份冻结的材料原样提交，
 * 提示词用用户最后那一份，不再过一次模型。
 *
 * 确认是幂等的：双击、两个标签页、网络重发都只会有一条任务。任务建出来之后进程若死在写回之前，
 * 下一次确认按草稿 id（同时是提交时的幂等命令 id）找回那条任务并认领它，不会再扣一次费。
 */

const drafts = schema.agent_generation_drafts

/** 标题长度与生图/改图、生视频工具的 `call()` 同一个算式，重算出来的那行才和原来一个样子。 */
const TITLE_MAX_CHARS = 40
const VIDEO_TITLE_MAX_CHARS = 32

/** 一次工具调用准备好、等用户确认的那份提交材料。 */
export interface GenerationDraftInput {
  readonly conversationId: string
  readonly turnId: string
  readonly toolCallId: string
  readonly toolName: AgentToolName
  readonly media: ChannelMedia
  readonly provider: QueueProvider
  readonly model: string
  /** 拟好的完整提示词：卡上给用户看的、他改的就是这一句。 */
  readonly prompt: string
  /** 送进上游的整份请求，输入图与遮罩此刻还是 data URL。 */
  readonly request: SubmitRequest
  readonly video?: PersistedVideoRequest
  readonly submission: AgentDraftSubmission
}

/**
 * 把这次调用准备好的材料存起来，等用户确认。输入图归档进对象存储，库里只留引用——卡片是下发给
 * 前端的公开内容，字节一律不进那里。存不下就抛：与其留一张点不动的卡，不如当场让这次调用失败。
 */
export async function saveGenerationDraft(
  input: GenerationDraftInput,
  persist?: (draft: typeof drafts.$inferInsert) => Promise<string>,
): Promise<string> {
  const id = crypto.randomUUID()
  let request: PersistedSubmitRequest
  try {
    request = {
      ...(await archiveInputImages(id, input.request)),
      ...(input.video ? { video: input.video } : {}),
    }
  } catch (error) {
    await discardDraftInputs(id)
    if (error instanceof TypeError) throw new AgentToolError('invalid_params', error.message)
    throw new AgentToolError(
      'upstream_error',
      error instanceof ObjectStorageError ? error.message : '保存待确认的生成材料失败',
    )
  }
  try {
    const prepared: typeof drafts.$inferInsert = {
      id,
      conversation_id: input.conversationId,
      turn_id: input.turnId,
      tool_call_id: input.toolCallId,
      tool_name: input.toolName,
      media: input.media,
      provider: input.provider,
      model: input.model,
      prompt: input.prompt,
      drafted_prompt: input.prompt,
      request,
      submission: input.submission,
      created_at: Date.now(),
    }
    if (persist) {
      const savedId = await persist(prepared)
      if (savedId !== id) await discardDraftInputs(id)
      return savedId
    }
    await db.insert(drafts).values(prepared)
    return id
  } catch (error) {
    await discardDraftInputs(id)
    throw error
  }
}

export interface ConfirmGenerationInput {
  readonly draftRevision?: number
  readonly conversationId: string
  /** 起这次确认时确权用的归属；建任务之前再核一次，中途易主或会话被删就不提交。 */
  readonly owner: AgentOwner
  /** 那张待确认卡片的消息 id。 */
  readonly messageId: string
  /** 用户最后看到、最后改过的提示词，原样提交。 */
  readonly prompt: string
  readonly deviceId: string
  readonly userId: string | null
}

export type ConfirmGenerationOutcome =
  | {
      readonly kind: 'created'
      readonly message: AgentMessageView
      /** 确认门拦下的那一轮排上了续跑（见 `tool-gate.ts`）：调用方要去接着开轮。 */
      readonly continued?: true
    }
  /** 这张卡已经确认过：交回同一张已提交的卡，不再提交第二次。 */
  | { readonly kind: 'replayed'; readonly message: AgentMessageView; readonly continued?: true }
  | { readonly kind: 'not_found' }
  /** 这条消息不是一张等确认的生成卡，或者它的材料已经不在了。 */
  | { readonly kind: 'not_confirmable' }
  | { readonly kind: 'refused'; readonly code: AgentToolErrorCode }

type DraftRow = typeof drafts.$inferSelect

interface ToolCard {
  readonly messageId: string
  readonly conversationId: string
  readonly turnId: string
  readonly createdAt: number
  readonly content: readonly AgentContentBlock[]
  readonly block: AgentToolResultBlock
}

/**
 * 用户确认了一张待确认卡。提示词按他给的那一份提交，其余（模型、参数、参考图、遮罩、档位）
 * 全部取自拟稿那一刻冻结的材料。
 *
 * 输入图从对象存储取回这一步在事务外做完：事务一开就握着一条连接，在里面等对象存储会把连接池
 * 拖垮。随后整件事在一把会话级咨询锁下串成一条——删除会话走同一把锁，所以确认不会把任务建进
 * 一个刚被删掉的会话；任务、后台任务登记、草稿认领与卡片改写同一次提交，任务能被 worker 看见时
 * 卡片一定已经是「已提交」，唤醒不会落空。
 */
export async function confirmAgentGeneration(
  input: ConfirmGenerationInput,
): Promise<ConfirmGenerationOutcome> {
  const prompt = input.prompt.trim()
  const prepared = await prepareConfirmation(input, prompt)
  if ('kind' in prepared) return prepared
  const outcome = await db.transaction(
    async (tx): Promise<ConfirmGenerationOutcome & { readonly draftId?: string }> => {
      await lockConversation(
        tx,
        input.conversationId,
        input.owner.kind === 'user' ? input.owner.userId : null,
      )
      const card = await readToolCard(tx, input.conversationId, input.messageId)
      if (!card) return { kind: 'not_found' }
      // 已经提交过的卡（双击、另一台设备、网络重发）：原样交回，不再提交。确认门的卡顺带补一次
      // 续跑：按轮去重，排过就不再排；还没被起轮取走的，让调用方再去开一次轮。
      if (card.block.status !== 'awaiting_confirmation') {
        if (!card.block.job) return { kind: 'not_confirmable' }
        return {
          kind: 'replayed',
          message: messageOf(card),
          ...(await continueGatedTurn(tx, card, input)),
        }
      }
      // 确认门的卡一旦有更晚的用户消息进了收件箱就算作废：作废发生在那条消息起轮时，这里与它
      // 同一把会话锁，不论确认与起轮谁先拿到锁，「先发了新消息」的卡都交不出去。
      if (
        card.block.gated === true &&
        (await userMessageSince(tx, input.conversationId, card.createdAt))
      )
        return { kind: 'not_confirmable' }
      const draft = await readDraft(tx, input.conversationId, card)
      if (!draft) return { kind: 'not_confirmable' }
      // 这份草稿已经用掉了（上一次确认写回卡片之前进程死了）：认领那条任务，不再提交。
      if (draft.task_id) {
        const message = await writeSubmitted(tx, card, draft, draft.prompt, draft.task_id)
        return { kind: 'replayed', message, ...(await continueGatedTurn(tx, card, input)) }
      }
      const adopted = await taskOfCommand(tx, draft)
      if (adopted) {
        const message = await claimSubmitted(tx, card, draft, adopted.prompt, adopted.taskId)
        return { kind: 'replayed', message, ...(await continueGatedTurn(tx, card, input)) }
      }
      // 会话此刻仍在、仍是这个人的：删除与登录改挂都会动这一行，锁住它再建任务，
      // 付了费的任务就不会落进一个已经删掉或已经易主的会话。
      if (!(await conversationStillOwned(tx, input))) return { kind: 'not_found' }
      if (draft.submission.production) {
        const currentDraft = await readDraft(tx, input.conversationId, card)
        if (
          !currentDraft ||
          currentDraft.submission.productionDraftRevision !== prepared.draftRevision ||
          !(await validateProductionConfirmation(
            input.conversationId,
            input.userId,
            currentDraft.submission,
            tx,
          ))
        )
          return { kind: 'refused', code: 'invalid_params' }
      }

      // 发给上游的那一句在这里才成形：创作页在分发层加的防改写 guard 与构图指令，这条路
      // 以前一段都不加。卡上展示、用户编辑的仍是不带机器指令的原句，所以变换只发生在提交这一刻。
      const upstreamPrompt =
        draft.media === 'image'
          ? shapeQueuePrompt({
              provider: draft.provider,
              model: draft.model,
              prompt,
              size: prepared.request.size,
            })
          : prompt

      if (prepared.video) {
        const rejected = agentVideoRequestError(
          draft.model,
          upstreamPrompt,
          prepared.video,
          prepared.request.input_images?.length ?? 0,
        )
        if (rejected) return { kind: 'refused', code: rejected.code }
      }
      const submitted = await createQueueTask({
        tx,
        provider: draft.provider,
        model: draft.model,
        request: {
          ...prepared.request,
          prompt: upstreamPrompt,
          device_id: input.deviceId,
          client_request_id: draft.id,
        },
        ...(prepared.video ? { video: prepared.video } : {}),
        userId: input.userId,
        agent: {
          conversationId: draft.conversation_id,
          turnId: draft.turn_id,
          job: {
            toolCallId: draft.tool_call_id,
            wakeOnSuccess: draft.submission.review,
            ...(draft.submission.plan ? { plan: draft.submission.plan } : {}),
          },
        },
      })
      if (submitted.kind !== 'created') {
        log.warn(
          { event: 'agent.confirmation_refused', draftId: draft.id, reason: submitted.kind },
          'confirmed generation was not submitted',
        )
        // 提交没成：草稿原样留着，用户改了提示词、充了积分还能再确认一次。
        return { kind: 'refused', code: queueRefusalCode(submitted.kind) }
      }
      const message = await claimSubmitted(tx, card, draft, prompt, submitted.taskId)
      return {
        kind: 'created',
        draftId: draft.id,
        message,
        ...(await continueGatedTurn(tx, card, input)),
      }
    },
  )
  // 任务已经把输入图归档到自己名下，草稿那一份不必再留。删不掉只是个孤儿，由 bucket lifecycle 收。
  if (outcome.draftId) await discardDraftInputs(outcome.draftId)
  const { draftId: _draftId, ...result } = outcome
  return result
}

interface PreparedConfirmation {
  readonly draftRevision?: number
  readonly request: Omit<SubmitRequest, 'video'>
  readonly video?: PersistedVideoRequest
}

/**
 * 事务外能做完的那几件：提示词合规、冻结的模型此刻还在不在、输入图取回。三件都不写库，
 * 失败即回绝，草稿原样留着。
 */
async function prepareConfirmation(
  input: ConfirmGenerationInput,
  prompt: string,
): Promise<PreparedConfirmation | ConfirmGenerationOutcome> {
  const card = await readToolCard(db, input.conversationId, input.messageId)
  if (!card) return { kind: 'not_found' }
  if (card.block.status !== 'awaiting_confirmation') {
    if (!card.block.job) return { kind: 'not_confirmable' }
    // 已提交的确认门卡交给事务里的重放分支：那里在锁内补排续跑，原样交回已提交的卡，不读这份
    // request/video、不提交任何东西，所以这里不必再做提示词与视频参数的校验（还在等确认的卡
    // 照常走下面完整的准备与校验）。
    if (card.block.gated === true) return { request: { prompt }, video: undefined }
    return { kind: 'replayed', message: messageOf(card) }
  }
  const draft = await readDraft(db, input.conversationId, card)
  if (!draft) return { kind: 'not_confirmable' }
  // 已经用掉的草稿交给事务里的重放分支处理：那里要写回卡片。
  if (draft.task_id) return { request: { prompt }, video: undefined }
  if (!prompt || prompt.length > AGENT_CONFIRMATION_PROMPT_MAX_CHARS)
    return { kind: 'refused', code: 'invalid_params' }
  // 拟稿到现在可能过了很久：模型下线、渠道改配置之后，冻结的那一个未必还在。
  // 不替用户换一个——换了就是拿他没选过的模型花他的钱。
  const target = resolveQueueModel(draft.media, draft.model)
  if (!target || target.model !== draft.model || target.provider !== draft.provider)
    return { kind: 'refused', code: 'model_unavailable' }
  if (draft.submission.production) {
    if (
      input.draftRevision !== (draft.submission.productionDraftRevision ?? 1) ||
      !(await validateProductionConfirmation(input.conversationId, input.userId, draft.submission))
    )
      return { kind: 'refused', code: 'invalid_params' }
    try {
      if (draft.media === 'image')
        validateImageParameters(
          draft.model,
          draft.provider,
          draft.submission.productionParams,
          (draft.submission.productionReferences ?? []).length,
        )
    } catch {
      return { kind: 'refused', code: 'invalid_params' }
    }
  }
  const { video, client_request_id: _command, ...persisted } = draft.request
  try {
    const { video: _hydratedVideo, ...request } = await hydrateInputImages(persisted)
    return {
      request,
      ...(video ? { video } : {}),
      ...(draft.submission.production
        ? { draftRevision: draft.submission.productionDraftRevision ?? 1 }
        : {}),
    }
  } catch (error) {
    log.error(
      { event: 'agent.confirmation_inputs_unreadable', draftId: draft.id, err: error },
      'draft inputs could not be read',
    )
    return { kind: 'refused', code: 'upstream_error' }
  }
}

function readDraft(
  executor: typeof db | BffTransaction,
  conversationId: string,
  card: ToolCard,
): Promise<DraftRow | undefined> {
  return executor
    .select()
    .from(drafts)
    .where(
      and(
        eq(drafts.conversation_id, conversationId),
        eq(drafts.turn_id, card.turnId),
        eq(drafts.tool_call_id, card.block.toolCallId),
      ),
    )
    .limit(1)
    .then((rows) => rows[0])
}

/** 会话还在、没被删、归属没变过。行锁住到提交为止：删除与登录改挂都得等这次确认落定。 */
async function conversationStillOwned(
  tx: BffTransaction,
  input: ConfirmGenerationInput,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: schema.agent_conversations.id })
    .from(schema.agent_conversations)
    .where(
      and(
        eq(schema.agent_conversations.id, input.conversationId),
        input.owner.kind === 'user'
          ? eq(schema.agent_conversations.user_id, input.owner.userId)
          : eq(schema.agent_conversations.device_id, input.owner.deviceId),
        isNull(schema.agent_conversations.deleted_at),
      ),
    )
    .limit(1)
    .for('update')
  return row !== undefined
}

/**
 * 确认门拦下的卡（见 `tool-gate.ts`）确认之后：那一轮拦下的卡都确认完了，就在同一个事务里排一次
 * 续跑，让那一轮接着往下走；还有没确认的就先不排，等最后一张。卡片改写与续跑同一次提交——
 * 任务建了而续跑丢了、或续跑排了而卡还停在待确认，两种都不会出现。续跑按轮去重，只排一次。
 */
async function continueGatedTurn(
  tx: BffTransaction,
  card: ToolCard,
  input: ConfirmGenerationInput,
): Promise<{ readonly continued?: true }> {
  if (card.block.gated !== true) return {}
  // 卡片已经在这个事务里改写成已提交：查到的只会是同一轮里别的、还没确认的卡。
  if (await turnHasPendingGate(tx, input.conversationId, card.turnId)) return {}
  const snapshot = card.block.snapshot
  const queued = await enqueueAgentResume(
    input.conversationId,
    {
      interruptedTurnId: card.turnId,
      deviceId: input.deviceId,
      ...(snapshot?.mode ? { mode: snapshot.mode } : {}),
      ...(snapshot?.params ? { params: snapshot.params } : {}),
      gate: true,
    },
    Date.now(),
    tx,
  )
  if (queued) return { continued: true }
  // 早就排过（上一次确认的响应丢了、另一台设备、重放）：续跑还在等或正在跑，就照样告诉调用方
  // 去跟进（还在等的顺带再开一次轮，正在跑的开轮是空操作）；跑完了就不再碰。
  return (await gateResumeLive(tx, input.conversationId, card.turnId)) ? { continued: true } : {}
}

/**
 * 用户没确认就发了新消息：这个会话里所有还在等的确认门卡就地改成作废（`failed` + `cancelled`），
 * 草稿的输入图一并丢掉。与确认握同一把会话锁，所以一张卡只会有一个结局：先确认的那一下赢，
 * 作废看到的就是已提交；先作废的话，晚到的确认看到的是一张不能再确认的卡。返回作废了几张。
 */
export async function voidPendingToolGates(
  conversationId: string,
  userId: string | null,
): Promise<number> {
  const voided = await db.transaction(async (tx) => {
    // 先锁再读，与确认同一个顺序：不在锁外先看一眼「没有」就走，那一眼与确认、落卡之间没有先后。
    await lockConversation(tx, conversationId, userId)
    const locked = await pendingGateMessages(tx, conversationId)
    // 草稿按「哪一轮的哪一次调用」认：调用 id 只在一轮里唯一，别的轮可能也有一个 `call-1`。
    const drafts: { readonly turnId: string; readonly toolCallId: string }[] = []
    for (const row of locked) {
      const content = row.content.map((block): AgentContentBlock => {
        if (!isPendingGate(block)) return block
        drafts.push({ turnId: row.turnId, toolCallId: block.toolCallId })
        return {
          ...block,
          status: 'failed',
          errorCode: 'cancelled',
          message: GATE_VOIDED_MESSAGE,
        }
      })
      await tx
        .update(schema.agent_messages)
        .set({ content })
        .where(
          and(
            eq(schema.agent_messages.conversation_id, conversationId),
            eq(schema.agent_messages.id, row.id),
          ),
        )
    }
    if (!drafts.length) return []
    const rowsOfDrafts = await tx
      .select({ id: schema.agent_generation_drafts.id })
      .from(schema.agent_generation_drafts)
      .where(
        and(
          eq(schema.agent_generation_drafts.conversation_id, conversationId),
          or(
            ...drafts.map((one) =>
              and(
                eq(schema.agent_generation_drafts.turn_id, one.turnId),
                eq(schema.agent_generation_drafts.tool_call_id, one.toolCallId),
              ),
            ),
          ),
          isNull(schema.agent_generation_drafts.task_id),
        ),
      )
    return rowsOfDrafts.map((draft) => draft.id)
  })
  // 作废的稿再也确认不了，归档的输入图没有读路径了；删不掉只是个孤儿，由 bucket lifecycle 收。
  // 各删各的，单个失败已在里面吞掉：并发删，作废多张卡时新消息不按张数排队等对象存储。
  await Promise.all(voided.map((id) => discardDraftInputs(id)))
  return voided.length
}

async function discardDraftInputs(draftId: string): Promise<void> {
  try {
    await objectStore().deletePrefix(`${draftId}/in/`)
  } catch {
    // Bucket lifecycle cleanup removes any orphan.
  }
}

/**
 * 会话删掉之后，它名下那些从没被确认过的草稿就再也点不动了，归档的输入图也就没了读路径。
 * 已确认的草稿输入图在确认那一刻就丢过一次，这里再清一遍是幂等的。
 * 只按会话删，不按时间——待确认卡不因为放久了而过期。
 */
export async function discardConversationDraftInputs(conversationId: string): Promise<void> {
  const rows = await db
    .select({ id: drafts.id })
    .from(drafts)
    .where(eq(drafts.conversation_id, conversationId))
  for (const row of rows) await discardDraftInputs(row.id)
}

/**
 * 会话级的咨询锁：确认与删除会话都握它，所以「建任务」与「删会话、取消任务」不会交错。
 * 同一个会话里的两次确认也因此串成一条，双击只会有一条任务。
 */
export async function lockConversation(
  tx: BffTransaction,
  conversationId: string,
  userId: string | null,
): Promise<void> {
  // 项目回收也先锁用户再锁会话；确认、删除与回收必须遵守同一个顺序。
  if (userId) await lockMediaOwner(tx, userId)
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['agent-conversation', conversationId])}, 0))`,
  )
}

async function readToolCard(
  executor: typeof db | BffTransaction,
  conversationId: string,
  messageId: string,
): Promise<ToolCard | null> {
  const [row] = await executor
    .select()
    .from(schema.agent_messages)
    .where(
      and(
        eq(schema.agent_messages.conversation_id, conversationId),
        eq(schema.agent_messages.id, messageId),
        isNull(schema.agent_messages.deleted_at),
      ),
    )
    .limit(1)
  if (!row) return null
  const block = row.content.find((one): one is AgentToolResultBlock => one.type === 'toolResult')
  if (!block) return null
  return {
    messageId: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    createdAt: row.created_at,
    content: row.content,
    block,
  }
}

function messageOf(card: ToolCard, block: AgentToolResultBlock = card.block): AgentMessageView {
  return {
    id: card.messageId,
    turnId: card.turnId,
    role: 'assistant',
    content: card.content.map((one) => (one === card.block ? block : one)),
    createdAt: card.createdAt,
  }
}

/** 这条草稿的命令 id 下已经建出来的任务：进程死在建任务与写回之间时靠它认领，不重复提交。 */
async function taskOfCommand(
  tx: BffTransaction,
  draft: DraftRow,
): Promise<{ readonly taskId: string; readonly prompt: string } | null> {
  const [task] = await tx
    .select({ id: schema.tasks.id, request: schema.tasks.request_payload })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.client_request_id, draft.id),
        eq(schema.tasks.agent_conversation_id, draft.conversation_id),
      ),
    )
    .limit(1)
  if (!task) return null
  // 落库那一句带着提交时钉上去的机器指令，卡片要回的是用户当初确认的原文。
  return {
    taskId: task.id,
    prompt: unshapeQueuePrompt({
      provider: draft.provider,
      prompt: task.request.prompt,
      size: draft.request.size,
    }),
  }
}

/** 记下这份草稿用掉了哪条任务，再把卡片改写成「已提交」。两件事同一个事务。 */
async function claimSubmitted(
  tx: BffTransaction,
  card: ToolCard,
  draft: DraftRow,
  prompt: string,
  taskId: string,
): Promise<AgentMessageView> {
  await tx
    .update(drafts)
    .set({ task_id: taskId, confirmed_at: Date.now(), prompt })
    .where(and(eq(drafts.id, draft.id), isNull(drafts.task_id)))
  return writeSubmitted(tx, card, draft, prompt, taskId)
}

/**
 * 卡面标题跟着真正提交的那一句走：用户把「浅灰绿色」改成白色之后，卡上那行标签不能还写着绿色。
 * 只在标题确实是从拟稿提示词截出来的时候重算——「编辑选区」这类固定标签照旧，免得凭空编一个说法。
 */
function retitle(title: string, drafted: string, confirmed: string): string {
  if (title === agentTitleLine(drafted, TITLE_MAX_CHARS))
    return agentTitleLine(confirmed, TITLE_MAX_CHARS)
  if (title === `视频：${agentTitleLine(drafted, VIDEO_TITLE_MAX_CHARS)}`)
    return `视频：${agentTitleLine(confirmed, VIDEO_TITLE_MAX_CHARS)}`
  return title
}

/** 卡片就地改写：消息 id 不变，提示词与标题换成真正提交的那一份，结局跟着后台任务走。 */
async function writeSubmitted(
  tx: BffTransaction,
  card: ToolCard,
  draft: DraftRow,
  prompt: string,
  taskId: string,
): Promise<AgentMessageView> {
  if (card.block.job?.taskId === taskId) return messageOf(card)
  const job: AgentBackgroundJob = {
    taskId,
    media: draft.media,
    ...(draft.submission.videoRecord ? { video: draft.submission.videoRecord } : {}),
    ...(draft.submission.review ? { review: true as const } : {}),
  }
  const block: AgentToolResultBlock = {
    ...card.block,
    status: 'submitted',
    title: retitle(card.block.title, draft.prompt, prompt),
    prompt,
    job,
  }
  const content = card.content.map((one) => (one === card.block ? block : one))
  await tx
    .update(schema.agent_messages)
    .set({ content: [...content] })
    .where(
      and(
        eq(schema.agent_messages.conversation_id, card.conversationId),
        eq(schema.agent_messages.id, card.messageId),
      ),
    )
  return messageOf(card, block)
}
