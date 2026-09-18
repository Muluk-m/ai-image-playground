// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { agentDraft, DraftSession, removeProjectDraft } from '../../../../features/agent/lib/drafts'
import { EMPTY_DRAFT } from '../../../../features/agent/lib/references'
import { createSelectionReferences } from '../../../../features/agent/lib/selectionReferences'
import { CanvasDoc } from '../../../../features/canvas/lib/canvasDoc'

async function ready(session: DraftSession) {
  await vi.waitFor(() => expect(session.getSnapshot().loading).toBe(false))
}

/** 让页面隐藏那一刻排下的写事务先进队；此刻 300ms 的 debounce 还没到，落盘只可能来自它。 */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0))

function hidePage() {
  window.dispatchEvent(new Event('pagehide'))
}

/** 存储里那份草稿的文字：读回来的非空草稿先作为未发送草稿等用户决定。 */
async function storedPrompt(key: string): Promise<string> {
  const restored = new DraftSession(key)
  await ready(restored)
  const { unsent, draft } = restored.getSnapshot()
  return (unsent ?? draft).prompt
}

describe('草稿恢复', () => {
  it('刷新后文字、图片和遮罩作为未发送草稿读回，恢复后进输入框，会话之间互不串用', async () => {
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
    expect(restored.getSnapshot().unsent).toEqual(draft)
    expect(restored.getSnapshot().draft).toEqual(EMPTY_DRAFT)
    expect(other.getSnapshot().unsent).toBeNull()
    expect(other.getSnapshot().draft.prompt).toBe('')

    restored.restoreUnsent()
    expect(restored.getSnapshot().draft).toEqual(draft)
    expect(restored.getSnapshot().unsent).toBeNull()
  })
  it('跟着选区自动带进来的参考图，读回来仍跟着选区走', async () => {
    const doc = new CanvasDoc()
    doc.restore(
      [
        {
          id: 'canvas-1',
          type: 'image',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          rotation: 0,
          fileId: 'file-1',
        },
        {
          id: 'canvas-2',
          type: 'image',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          rotation: 0,
          fileId: 'file-2',
        },
      ],
      { 'file-1': 'data:image/png;base64,aGk=', 'file-2': 'data:image/png;base64,b3RoZXI=' },
    )
    const session = new DraftSession('auto-reference')
    await ready(session)
    doc.setSelection(['canvas-1'])
    createSelectionReferences().follow(doc, session.update, undefined, session.key)
    await session.flush()

    const restored = new DraftSession('auto-reference')
    await ready(restored)
    doc.setSelection(['canvas-2'])
    createSelectionReferences().follow(doc, restored.update, undefined, restored.key)

    expect(restored.getSnapshot().draft.references.map((one) => one.id)).toEqual(['canvas-2'])
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
  expect(await storedPrompt('two-tabs')).toBe('另一页的新内容')
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

describe('未发送的草稿', () => {
  async function leftBehind(key: string, draft: Parameters<DraftSession['update']>[0]) {
    const session = new DraftSession(key)
    await ready(session)
    session.update(draft)
    await session.flush()
    const restored = new DraftSession(key)
    await ready(restored)
    return restored
  }

  it('视频模式跟着会话走，不等恢复', async () => {
    const restored = await leftBehind('unsent-mode', {
      prompt: '做个开箱短片',
      references: [],
      mode: 'video',
    })
    expect(restored.getSnapshot().draft).toEqual({ ...EMPTY_DRAFT, mode: 'video' })
    expect(restored.getSnapshot().unsent?.prompt).toBe('做个开箱短片')
  })

  it('不理它、输入框空着时落盘也不会把它冲掉', async () => {
    const restored = await leftBehind('unsent-ignored', { prompt: '还没发的话', references: [] })
    restored.update({ prompt: '临时', references: [] })
    restored.update({ prompt: '', references: [] })
    await restored.flush()
    expect(await storedPrompt('unsent-ignored')).toBe('还没发的话')
  })

  it('丢弃后刷新不再出现', async () => {
    const restored = await leftBehind('unsent-discarded', { prompt: '不要了', references: [] })
    restored.discardUnsent()
    expect(restored.getSnapshot().unsent).toBeNull()
    await restored.flush()
    const again = new DraftSession('unsent-discarded')
    await ready(again)
    expect(again.getSnapshot().unsent).toBeNull()
    expect(again.getSnapshot().draft.prompt).toBe('')
  })

  it('恢复后落盘的就是恢复出来的那份，跟着选区带进来的图一起留着', async () => {
    const restored = await leftBehind('unsent-restored', { prompt: '接着改', references: [] })
    const selected = {
      id: 'canvas-1',
      dataUrl: 'data:image/png;base64,aGk=',
      origin: 'selection' as const,
    }
    restored.update((draft) => ({ ...draft, references: [selected] }))
    restored.restoreUnsent()
    expect(restored.getSnapshot().draft).toEqual({ prompt: '接着改', references: [selected] })
    await restored.flush()
    expect(await storedPrompt('unsent-restored')).toBe('接着改')
  })

  it('只剩跟着选区带进来的图不算没发出去的话，照旧直接放回', async () => {
    const draft = {
      prompt: '',
      references: [
        { id: 'canvas-1', dataUrl: 'data:image/png;base64,aGk=', origin: 'selection' as const },
      ],
    }
    const restored = await leftBehind('unsent-selection-only', draft)
    expect(restored.getSnapshot().unsent).toBeNull()
    expect(restored.getSnapshot().draft).toEqual(draft)
  })
})
