import type { AgentTurnReference } from '@image-playground/shared'
import { describe, expect, it, vi } from 'vitest'
import {
  createOutgoingSubmission,
  type OutgoingJournalPort,
  type OutgoingSubmissionInput,
} from '../../../../features/agent/lib/outgoingSubmission'
import type { TurnSubmissionSnapshot } from '../../../../features/agent/lib/turnSubmission'

const original = [{ imageId: 'img-1', dataUrl: 'blob:local' }] as unknown as AgentTurnReference[]
const uploaded = [{ imageId: 'img-1', mediaId: 'm-1' }] as unknown as AgentTurnReference[]
const snapshot: TurnSubmissionSnapshot = { references: original, experience: 'chat' }

function harness(patch: Partial<OutgoingSubmissionInput> = {}) {
  let account = true
  const order: string[] = []
  const journal = {
    remember: vi.fn(async () => void order.push('remember')),
    updateInput: vi.fn(async () => {}),
    bindConversation: vi.fn(async () => {}),
    forget: vi.fn(async () => void order.push('forget')),
  } satisfies OutgoingJournalPort
  const localPersistence = {
    stage: vi.fn(async () => void order.push('stage')),
    committed: vi.fn(() => void order.push('committed')),
  }
  const draft = {
    ready: Promise.resolve(),
    returnUnsent: vi.fn(async () => true),
  }
  const draftFor = vi.fn(() => draft)
  const prepare = vi.fn(
    async (): Promise<TurnSubmissionSnapshot | null> => ({
      references: uploaded,
      experience: 'chat',
      params: { quality: 'high' } as never,
    }),
  )
  const input: OutgoingSubmissionInput = {
    id: 'msg-1',
    text: '画一只猫',
    mode: 'agent' as never,
    clarificationAnswer: false,
    conversationId: 'c1',
    projectId: 'p1',
    snapshot,
    prepare,
    sameAccount: () => account,
    localPersistence,
    journal,
    draft: draftFor,
    now: () => 42,
    newId: () => 'msg-new',
    ...patch,
  }
  return {
    outgoing: createOutgoingSubmission(input),
    journal,
    localPersistence,
    draft,
    draftFor,
    prepare,
    order,
    switchAccount: () => {
      account = false
    },
  }
}

describe('createOutgoingSubmission', () => {
  describe('persist', () => {
    it('先交给输入框暂存，再写本机日志，写好才通知输入框放手', async () => {
      const h = harness({ modelOverride: 'model-x' })
      expect(await h.outgoing.persist()).toBe(true)
      expect(h.order).toEqual(['stage', 'remember', 'committed'])
      expect(h.localPersistence.stage).toHaveBeenCalledWith({
        ...snapshot,
        id: 'msg-1',
        text: '画一只猫',
        mode: 'agent',
        clarificationAnswer: false,
      })
      expect(h.journal.remember).toHaveBeenCalledWith({
        id: 'msg-1',
        projectId: 'p1',
        conversationId: 'c1',
        text: '画一只猫',
        ...snapshot,
        mode: 'agent',
        modelOverride: 'model-x',
        clarificationAnswer: false,
        createdAt: 42,
      })
    })

    it('没有项目时无处归属：只暂存，不写日志也不通知放手', async () => {
      const h = harness({ projectId: undefined })
      expect(await h.outgoing.persist()).toBe(true)
      expect(h.order).toEqual(['stage'])
    })

    it('暂存期间换了账号：不写日志，返回 false', async () => {
      const h = harness()
      h.localPersistence.stage.mockImplementationOnce(async () => h.switchAccount())
      expect(await h.outgoing.persist()).toBe(false)
      expect(h.journal.remember).not.toHaveBeenCalled()
    })

    it('写日志期间换了账号：返回 false', async () => {
      const h = harness()
      h.journal.remember.mockImplementationOnce(async () => h.switchAccount())
      expect(await h.outgoing.persist()).toBe(false)
    })
  })

  describe('prepare', () => {
    it('媒体身份补好后，本机日志改记新身份并保留原图引用，重试可以重新上传', async () => {
      const h = harness()
      const prepared = await h.outgoing.prepare()
      expect(prepared?.references).toBe(uploaded)
      expect(h.journal.updateInput).toHaveBeenCalledWith('p1', 'msg-1', {
        references: original,
        experience: 'chat',
        params: { quality: 'high' },
      })
    })

    it('引用没能上传（null）：不改日志', async () => {
      const h = harness()
      h.prepare.mockResolvedValueOnce(null)
      expect(await h.outgoing.prepare()).toBeNull()
      expect(h.journal.updateInput).not.toHaveBeenCalled()
    })

    it.each([
      ['准备之前', (h: ReturnType<typeof harness>) => h.switchAccount()],
      [
        '上传期间',
        (h: ReturnType<typeof harness>) =>
          h.prepare.mockImplementationOnce(async () => {
            h.switchAccount()
            return snapshot
          }),
      ],
      [
        '改日志期间',
        (h: ReturnType<typeof harness>) =>
          h.journal.updateInput.mockImplementationOnce(async () => h.switchAccount()),
      ],
    ])('%s换了账号：抛 media_scope_changed', async (_, arrange) => {
      const h = harness()
      arrange(h)
      await expect(h.outgoing.prepare()).rejects.toThrow('media_scope_changed')
    })
  })

  it('会话刚建出来：本机日志补上会话；没有项目时不写', async () => {
    const h = harness()
    await h.outgoing.bindConversation('c-new')
    expect(h.journal.bindConversation).toHaveBeenCalledWith('p1', 'msg-1', 'c-new')
    const none = harness({ projectId: undefined })
    await none.outgoing.bindConversation('c-new')
    expect(none.journal.bindConversation).not.toHaveBeenCalled()
  })

  it('settle 忘掉本机日志；换了账号或没有项目时不动', async () => {
    const h = harness()
    await h.outgoing.settle()
    expect(h.journal.forget).toHaveBeenCalledWith('p1', 'msg-1')
    const switched = harness()
    switched.switchAccount()
    await switched.outgoing.settle()
    expect(switched.journal.forget).not.toHaveBeenCalled()
    const none = harness({ projectId: undefined })
    await none.outgoing.settle()
    expect(none.journal.forget).not.toHaveBeenCalled()
  })

  describe('returnUnsent', () => {
    it('交还给发送方的草稿，带上已补好的媒体身份与 quiet；放回了才忘日志', async () => {
      const onUnsent = vi.fn(async () => true)
      const h = harness({ onUnsent })
      await h.outgoing.prepare()
      await h.outgoing.returnUnsent(false, true)
      expect(onUnsent).toHaveBeenCalledWith(
        {
          references: original,
          experience: 'chat',
          params: { quality: 'high' },
          id: 'msg-1',
          text: '画一只猫',
          mode: 'agent',
          clarificationAnswer: false,
        },
        true,
      )
      expect(h.journal.forget).toHaveBeenCalledTimes(1)
      expect(h.draftFor).not.toHaveBeenCalled()
    })

    it('发送方没能落盘：本机日志留着，下次还能补发', async () => {
      const h = harness({ onUnsent: vi.fn(async () => false) })
      await h.outgoing.returnUnsent()
      expect(h.journal.forget).not.toHaveBeenCalled()
    })

    it('服务端已撤回：换新 id 交还，旧 id 已是终态', async () => {
      const onUnsent = vi.fn(async () => true)
      const h = harness({ onUnsent })
      await h.outgoing.returnUnsent(true)
      expect(onUnsent).toHaveBeenCalledWith(expect.objectContaining({ id: 'msg-new' }), false)
    })

    it('没有发送方草稿且不是撤回：什么都不做', async () => {
      const h = harness()
      await h.outgoing.returnUnsent()
      expect(h.draftFor).not.toHaveBeenCalled()
      expect(h.journal.forget).not.toHaveBeenCalled()
    })

    it('没有发送方草稿但服务端撤回了（刷新补发）：写回原项目的草稿', async () => {
      const h = harness()
      await h.outgoing.returnUnsent(true)
      expect(h.draftFor).toHaveBeenCalledWith('c1', 'p1')
      expect(h.draft.returnUnsent).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: '画一只猫',
          submission: expect.objectContaining({ id: 'msg-new', text: '画一只猫' }),
        }),
      )
      expect(h.journal.forget).toHaveBeenCalledWith('p1', 'msg-1')
    })
  })
})
