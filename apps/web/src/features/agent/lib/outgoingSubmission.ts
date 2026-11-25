import type { AgentMode } from '@image-playground/shared'
import { agentDraft } from './drafts'
import { returnQueuedToDraft } from './messageQueue'
import {
  bindOutgoingConversation,
  forgetOutgoing,
  rememberOutgoing,
  updateOutgoingInput,
} from './outgoingJournal'
import type { TurnSubmissionSnapshot, UnsentTurnSubmission } from './turnSubmission'

/** 输入框自己的落盘口子：交出去之前先暂存，本机日志写好后通知它可以放手。 */
export interface OutgoingLocalPersistence {
  stage(submission: UnsentTurnSubmission): Promise<void>
  committed(id: string): void
}

/** 本机发送日志的几个写口；默认是 `outgoingJournal`，测试换成假的。 */
export interface OutgoingJournalPort {
  readonly remember: typeof rememberOutgoing
  readonly updateInput: typeof updateOutgoingInput
  readonly bindConversation: typeof bindOutgoingConversation
  readonly forget: typeof forgetOutgoing
}

const defaultJournal: OutgoingJournalPort = {
  remember: (message) => rememberOutgoing(message),
  updateInput: (projectId, id, input) => updateOutgoingInput(projectId, id, input),
  bindConversation: (projectId, id, conversationId) =>
    bindOutgoingConversation(projectId, id, conversationId),
  forget: (projectId, id) => forgetOutgoing(projectId, id),
}

/** 草稿那一侧：刷新补发时输入框可能还没挂，直接把话写回原项目的草稿。 */
export interface OutgoingDraftPort {
  readonly ready: Promise<void>
  returnUnsent(
    draft: Parameters<ReturnType<typeof agentDraft>['returnUnsent']>[0],
  ): Promise<boolean>
}

export interface OutgoingSubmissionInput {
  readonly id: string
  readonly text: string
  readonly mode: AgentMode
  readonly clarificationAnswer: boolean
  readonly conversationId: string | null
  /** 发话时的项目；没有项目就不写本机日志（无处归属）。 */
  readonly projectId: string | undefined
  readonly modelOverride?: string
  /** 发话这一刻固定下来的输入（引用、画布、参数）。 */
  readonly snapshot: TurnSubmissionSnapshot
  /** 只补媒体身份；返回 null 表示引用没能上传。 */
  readonly prepare: () => Promise<TurnSubmissionSnapshot | null>
  /** 发话以来账号还是同一个。 */
  readonly sameAccount: () => boolean
  readonly localPersistence?: OutgoingLocalPersistence
  readonly onUnsent?: (submission: UnsentTurnSubmission, quiet?: boolean) => Promise<boolean>
  readonly journal?: OutgoingJournalPort
  readonly draft?: (
    conversationId: string | null,
    projectId: string | undefined,
  ) => OutgoingDraftPort
  readonly now?: () => number
  readonly newId?: () => string
}

export interface OutgoingSubmission {
  /**
   * 交出去之前先落本机并等它写完；账号换了返回 false。没有要落的东西时同步返回，
   * 调用方据此决定要不要 await——多等一拍会改变消息上屏与起轮的时机。
   */
  persist(): boolean | Promise<boolean>
  /** 准备媒体身份；成功后本机日志改记新身份，重试时不必再传原图。账号换了抛错。 */
  prepare(): Promise<TurnSubmissionSnapshot | null>
  /** 会话刚建出来：本机那份补上会话，重发时才知道发去哪里。 */
  bindConversation(conversationId: string): Promise<void>
  /** 服务端收下或用户停了：本机那份不必再留。 */
  settle(): Promise<void>
  /**
   * 服务端没收下：把这句话交还给草稿，落盘了才忘掉本机日志。`withdrawn` 是服务端已撤回
   * （那个 id 已是终态，换新 id）；`quiet` 是界面别处已经说清了原因。
   */
  returnUnsent(withdrawn?: boolean, quiet?: boolean): Promise<void>
}

/**
 * 一句话从敲下回车到服务端收下之间的本机生命周期。这句话与服务端之间隔着几秒网络，刷新、
 * 断网都在这段里：先落本机再发，收下了才忘；没收下就原样放回草稿，能拿同一个 id 重发。
 */
export function createOutgoingSubmission(input: OutgoingSubmissionInput): OutgoingSubmission {
  const journal = input.journal ?? defaultJournal
  const draftFor =
    input.draft ?? ((conversationId, projectId) => agentDraft(conversationId, projectId))
  const now = input.now ?? Date.now
  const newId = input.newId ?? (() => crypto.randomUUID())
  const journaled = input.projectId ? { projectId: input.projectId, id: input.id } : null
  // Unaccepted uploads can expire; retain the captured pixels for a fresh upload on retry.
  let submissionInput = input.snapshot

  const settle = async () => {
    if (journaled && input.sameAccount()) await journal.forget(journaled.projectId, journaled.id)
  }

  return {
    persist() {
      // 没有要落的（无项目、输入框也没交暂存）就同步判定：发送随即上屏起轮，不能平白多等一拍。
      if (!input.localPersistence && !journaled) return input.sameAccount()
      return (async () => {
        if (input.localPersistence) {
          await input.localPersistence.stage({
            ...input.snapshot,
            id: input.id,
            text: input.text,
            mode: input.mode,
            clarificationAnswer: input.clarificationAnswer,
          })
          if (!input.sameAccount()) return false
        }
        if (journaled) {
          await journal.remember({
            id: input.id,
            projectId: journaled.projectId,
            conversationId: input.conversationId,
            text: input.text,
            ...input.snapshot,
            mode: input.mode,
            ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
            clarificationAnswer: input.clarificationAnswer,
            createdAt: now(),
          })
          input.localPersistence?.committed(input.id)
        }
        return input.sameAccount()
      })()
    },

    async prepare() {
      if (!input.sameAccount()) throw new Error('media_scope_changed')
      const prepared = await input.prepare()
      if (!input.sameAccount()) throw new Error('media_scope_changed')
      if (prepared) submissionInput = { ...prepared, references: input.snapshot.references }
      if (prepared && journaled)
        await journal.updateInput(journaled.projectId, journaled.id, submissionInput)
      if (!input.sameAccount()) throw new Error('media_scope_changed')
      return prepared
    },

    async bindConversation(conversationId) {
      if (journaled)
        await journal.bindConversation(journaled.projectId, journaled.id, conversationId)
    },

    settle,

    async returnUnsent(withdrawn = false, quiet = false) {
      if (!input.onUnsent && !withdrawn) return
      // 已撤回的 id 是服务端终态，再用它只会再次得到 cancelled。只有用户从草稿再发才开新 id。
      const unsent: UnsentTurnSubmission = {
        ...submissionInput,
        id: withdrawn ? newId() : input.id,
        text: input.text,
        mode: input.mode,
        clarificationAnswer: input.clarificationAnswer,
      }
      let returned: boolean
      if (input.onUnsent) returned = await input.onUnsent(unsent, quiet)
      else {
        // 刷新补发时输入框可能尚未挂载，恢复仍归属原项目，不能把终态日志直接丢掉。
        const draft = draftFor(input.conversationId, input.projectId)
        await draft.ready
        returned = await draft.returnUnsent({
          ...returnQueuedToDraft({ prompt: '', references: [] }, [unsent]),
          submission: unsent,
        })
      }
      if (returned) await settle()
    },
  }
}
