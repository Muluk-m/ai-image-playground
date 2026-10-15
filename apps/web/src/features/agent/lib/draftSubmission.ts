import type { AgentMode, AgentTurnReference } from '@image-playground/shared'
import { accountScope } from '../../../lib/authScope'
import {
  attachmentSourceOwner,
  hasLocalAttachmentSources,
} from '../../../lib/localAttachmentSources'
import type { DraftSession } from './drafts'
import { rememberAgentPrompt } from './promptHistory'
import { type AgentDraft, draftForSubmit } from './references'
import type { TurnSubmissionReplay, UnsentTurnSubmission } from './turnSubmission'

export interface DraftSubmissionInput {
  session: DraftSession
  snapshot: AgentDraft
  mode: AgentMode
  onConsumed(): void
  onNotice(notice: 'cancelled' | 'failed'): void
}

/** Internal adapter to the existing command sender; UI callers use submitDraft. */
export type DraftSubmissionDispatch = (
  text: string,
  references?: readonly AgentTurnReference[],
  onAccepted?: () => void,
  mode?: AgentMode,
  clientMessageId?: string,
  replay?: TurnSubmissionReplay,
  modelOverride?: string,
  onUnsent?: (submission: UnsentTurnSubmission) => Promise<boolean>,
  localPersistence?: {
    stage(submission: UnsentTurnSubmission): Promise<void>
    committed(id: string): void
  },
) => Promise<void | 'cancelled'>

/** Own the draft side of the durable handoff, separately from server acceptance. */
export function submitDraft(
  { session, snapshot, mode, onConsumed, onNotice }: DraftSubmissionInput,
  dispatch: DraftSubmissionDispatch,
): Promise<void> {
  const submission = draftForSubmit(snapshot)
  if (!submission.text.trim()) return Promise.resolve()
  // 乐观发送：敲下回车输入框立刻清空，那句话已经在对话里了；服务端没收下再把草稿放回来。
  const handoff = hasLocalAttachmentSources(snapshot)
    ? attachmentSourceOwner(`sending:${crypto.randomUUID()}`)
    : undefined
  const releaseSubmission = session.beginSubmission()
  const sameAccount = accountScope()
  let stagedId: string | undefined
  let accepted = false
  let returnedToDraft = false
  const restore = (cancelled = false) => {
    returnedToDraft = true
    onNotice(cancelled ? 'cancelled' : 'failed')
    // 这几秒里用户要是已经开始打下一句，别把它冲掉。
    session.update((current) =>
      current.prompt.trim() || current.references.length
        ? current
        : { ...snapshot, submission: undefined },
    )
  }
  const acceptLocalDraft = () => {
    if (stagedId) session.acceptSubmission(stagedId)
    else session.accept(snapshot)
    onConsumed()
  }
  const send = () => {
    if (!sameAccount()) throw new Error('media_scope_changed')
    if (!handoff) acceptLocalDraft()
    return dispatch(
      snapshot.submission?.text ?? submission.text,
      snapshot.submission?.references ?? submission.references,
      () => {
        accepted = true
        if (handoff) acceptLocalDraft()
        if (sameAccount()) rememberAgentPrompt(snapshot.prompt)
        releaseSubmission()
      },
      snapshot.submission?.mode ?? mode,
      snapshot.submission?.id,
      snapshot.submission,
      undefined,
      async (retry) => {
        returnedToDraft = true
        onNotice('failed')
        return session.returnUnsent({ ...snapshot, submission: retry })
      },
      handoff
        ? {
            stage: async (command) => {
              if (!sameAccount()) throw new Error('media_scope_changed')
              stagedId = command.id
              await session.stageSubmission(snapshot, command)
            },
            committed: () => acceptLocalDraft(),
          }
        : undefined,
    )
  }
  return (handoff ? handoff.retain(snapshot).then(send) : send())
    .then(
      (outcome) => {
        if (!accepted && !returnedToDraft) restore(outcome === 'cancelled')
      },
      () => restore(),
    )
    .finally(async () => {
      try {
        await session.flush()
        if (!session.getSnapshot().error) await handoff?.release().catch(() => {})
      } finally {
        releaseSubmission()
      }
    })
}
