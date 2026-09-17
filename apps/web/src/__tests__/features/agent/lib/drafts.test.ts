// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { agentDraft, DraftSession, removeProjectDraft } from '../../../../features/agent/lib/drafts'

async function ready(session: DraftSession) {
  await vi.waitFor(() => expect(session.getSnapshot().loading).toBe(false))
}

/** 让页面隐藏那一刻排下的写事务先进队；此刻 300ms 的 debounce 还没到，落盘只可能来自它。 */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

function hidePage() {
  window.dispatchEvent(new Event('pagehide'))
}

async function storedPrompt(key: string): Promise<string> {
  const restored = new DraftSession(key)
  await ready(restored)
  return restored.getSnapshot().draft.prompt
}

describe('草稿恢复', () => {
  it('刷新后恢复文字、图片和遮罩，会话之间互不串用', async () => {
    const draft = {
      prompt: '改背景',
      references: [
        {
          id: 'image-1',
          dataUrl: 'data:image/png;base64,aGk=',
          maskDataUrl: 'data:image/png;base64,bWFzaw==',
        },
      ],
    }
    const session = new DraftSession('conversation-one')
    await ready(session)
    session.update(draft)
    await session.flush()
    const restored = new DraftSession('conversation-one')
    const other = new DraftSession('conversation-two')
    await Promise.all([ready(restored), ready(other)])
    expect(restored.getSnapshot().draft).toEqual(draft)
    expect(other.getSnapshot().draft.prompt).toBe('')
  })
  it('发送确认不能抹掉等待期间新输入的内容', async () => {
    const session = new DraftSession('pending-edit')
    await ready(session)
    const old = { prompt: '原消息', references: [] }
    session.update(old)
    session.update({ prompt: '原消息和新增说明', references: [] })
    session.accept(old)
    expect(session.getSnapshot().draft.prompt).toBe('原消息和新增说明')
    await session.flush()
  })
})

it('已保存的旧页面再次失焦时不会覆盖其它页面的新草稿', async () => {
  const old = new DraftSession('two-tabs')
  await ready(old)
  old.update({ prompt: '旧内容', references: [] })
  await old.flush()
  const other = new DraftSession('two-tabs')
  await ready(other)
  other.update({ prompt: '另一页的新内容', references: [] })
  await other.flush()
  await old.flush()
  const restored = new DraftSession('two-tabs')
  await ready(restored)
  expect(restored.getSnapshot().draft.prompt).toBe('另一页的新内容')
})

it('上一轮完成不能解除仍在上传的插话锁', async () => {
  const session = new DraftSession('submission-lock')
  await ready(session)
  const finishFirst = session.beginSubmission()
  finishFirst()
  const finishSecond = session.beginSubmission()
  finishFirst()
  expect(session.getSnapshot().submitting).toBe(true)
  finishSecond()
  expect(session.getSnapshot().submitting).toBe(false)
})

it('新建会话的草稿迁移与旧记录删除在同一事务内，确认后不恢复已发送内容', async () => {
  const session = new DraftSession('new-before-bind')
  await ready(session)
  const draft = { prompt: '新对话内容', references: [] }
  session.update(draft)
  await session.flush()
  session.moveTo('created-conversation')
  session.accept(draft)
  await session.flush()
  const old = new DraftSession('new-before-bind')
  const current = new DraftSession('created-conversation')
  await Promise.all([ready(old), ready(current)])
  expect(old.getSnapshot().draft.prompt).toBe('')
  expect(current.getSnapshot().draft.prompt).toBe('')
})

describe('输入框不在场', () => {
  it('页面被藏起来时照样把没落盘的草稿冲掉', async () => {
    const session = agentDraft('composer-unmounted')
    await ready(session)
    session.update({ prompt: '收起面板之后补上的内容', references: [] })
    hidePage()
    await settled()
    expect(await storedPrompt(session.key)).toBe('收起面板之后补上的内容')
  })

  it('已经删掉的草稿不会被页面隐藏又写回去', async () => {
    const session = agentDraft(null, 'removed-project')
    await ready(session)
    session.update({ prompt: '删掉之前的内容', references: [] })
    await removeProjectDraft('removed-project', null)
    session.update({ prompt: '删掉之后才写进来的内容', references: [] })
    hidePage()
    await settled()
    expect(await storedPrompt(session.key)).toBe('')
  })
})
