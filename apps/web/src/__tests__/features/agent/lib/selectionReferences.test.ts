import { describe, expect, it, vi } from 'vitest'
import {
  type AgentDraft,
  attachReference,
  EMPTY_DRAFT,
  referenceLabels,
  removeReference,
} from '../../../../features/agent/lib/references'
import { createSelectionReferences } from '../../../../features/agent/lib/selectionReferences'
import { CanvasDoc, type CanvasEl } from '../../../../features/canvas/lib/canvasDoc'
import { getVisiblePrompt } from '../../../../lib/promptImageMentions'

const PIXEL = 'data:image/png;base64,aGk='
const OTHER = 'data:image/png;base64,b3RoZXI='
const COMPOSITE = 'data:image/png;base64,bWFya2Vk'

function image(id: string, fileId: string): CanvasEl {
  return { id, type: 'image', x: 0, y: 0, width: 10, height: 10, rotation: 0, fileId }
}

/** 压在图上的一笔红圈：选中它就该跟着图一起进引用区。 */
const CIRCLE: CanvasEl = {
  id: 'circle',
  type: 'freedraw',
  points: [2, 2, 6, 6, 2, 6],
  stroke: '#f00',
  strokeWidth: 2,
}

function canvas(elements: CanvasEl[] = [image('canvas-1', 'file-1')]): CanvasDoc {
  const doc = new CanvasDoc()
  doc.restore(elements, { 'file-1': PIXEL, 'file-2': OTHER })
  return doc
}

/** 输入框那一侧：草稿在别人手里，选区只拿到一个改它的入口。 */
function drafts(initial: AgentDraft = EMPTY_DRAFT) {
  let draft = initial
  return {
    get current() {
      return draft
    },
    get ids() {
      return draft.references.map((one) => one.id)
    },
    get sources() {
      return draft.references.map((one) => one.dataUrl)
    },
    update: (change: (draft: AgentDraft) => AgentDraft) => {
      draft = change(draft)
    },
  }
}

function visible(draft: AgentDraft): string {
  return getVisiblePrompt(draft.prompt, referenceLabels(draft.references))
}

describe('跟着画布选区走的引用', () => {
  it('选中的画布图自动成为参考图，最上层的排在最前', () => {
    const doc = canvas([image('canvas-1', 'file-1'), image('canvas-2', 'file-2')])
    const selection = createSelectionReferences()
    const draft = drafts()

    doc.setSelection(['canvas-1', 'canvas-2'])
    selection.follow(doc, draft.update)

    expect(draft.ids).toEqual(['canvas-2', 'canvas-1'])
    expect(draft.sources).toEqual([OTHER, PIXEL])
  })

  it('取消选中就撤走，指向它的引用降级为已移除', () => {
    const doc = canvas()
    const selection = createSelectionReferences()
    const draft = drafts()

    doc.setSelection(['canvas-1'])
    selection.follow(doc, draft.update)
    // 用户接着 `@` 了这张自动带进来的图。
    draft.update((current) => attachReference(current, current.references[0]!, 0, 0).draft)
    expect(visible(draft.current)).toBe('@图1')

    doc.setSelection([])
    selection.follow(doc, draft.update)

    expect(draft.ids).toEqual([])
    expect(visible(draft.current)).toBe('@已移除图片')
  })

  it('用户手动移除自动带进来的那张后，选区没变就没有再同步的理由', () => {
    const doc = canvas()
    const selection = createSelectionReferences()
    const draft = drafts()

    doc.setSelection(['canvas-1'])
    const key = selection.key(doc)
    selection.follow(doc, draft.update)
    draft.update((current) => ({ ...current, references: [] }))

    // 选区没动过：调用方据这把钥匙判断不必再同步，那张图就不会被加回来。
    expect(selection.key(doc)).toBe(key)
    expect(draft.ids).toEqual([])
  })

  it('用户手动 `@` 进来的不归选区管，取消选中也留着', () => {
    const doc = canvas([image('canvas-1', 'file-1'), image('canvas-2', 'file-2')])
    const selection = createSelectionReferences()
    const draft = drafts({ prompt: '', references: [{ id: 'canvas-1', dataUrl: PIXEL }] })

    doc.setSelection(['canvas-1', 'canvas-2'])
    selection.follow(doc, draft.update)
    // 已经在条里的复用原位，选区只在后面续上新的那张。
    expect(draft.ids).toEqual(['canvas-1', 'canvas-2'])

    doc.setSelection([])
    selection.follow(doc, draft.update)

    expect(draft.ids).toEqual(['canvas-1'])
  })

  it('选中的批注烧进参考图；批注取消选中就回到原图', async () => {
    const doc = canvas([image('canvas-1', 'file-1'), CIRCLE])
    const toImage = vi.fn(async () => COMPOSITE)
    const selection = createSelectionReferences()
    const draft = drafts()

    doc.setSelection(['canvas-1', 'circle'])
    selection.follow(doc, draft.update, { toImage })
    // 先按原图带进来，烧好的版本随后替换。
    expect(draft.sources).toEqual([PIXEL])
    await vi.waitFor(() => expect(draft.sources).toEqual([COMPOSITE]))
    expect(toImage).toHaveBeenCalledWith(['canvas-1', 'circle'], {
      bounds: expect.objectContaining({ x: 0, y: 0, w: 10, h: 10 }),
    })

    doc.setSelection(['canvas-1'])
    selection.follow(doc, draft.update, { toImage })

    expect(draft.sources).toEqual([PIXEL])
  })

  it('烧图期间选区又变了，渲出来的那张丢掉', async () => {
    const doc = canvas([image('canvas-1', 'file-1'), CIRCLE])
    let finish!: (dataUrl: string) => void
    const toImage = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          finish = resolve
        }),
    )
    const selection = createSelectionReferences()
    const draft = drafts()

    doc.setSelection(['canvas-1', 'circle'])
    selection.follow(doc, draft.update, { toImage })
    doc.setSelection(['canvas-1'])
    selection.follow(doc, draft.update, { toImage })

    finish(COMPOSITE)
    await Promise.resolve()
    await Promise.resolve()

    expect(draft.sources).toEqual([PIXEL])
  })

  it('没有渲染器就只带原图，批注不烧', () => {
    const doc = canvas([image('canvas-1', 'file-1'), CIRCLE])
    const selection = createSelectionReferences()
    const draft = drafts()

    doc.setSelection(['canvas-1', 'circle'])
    selection.follow(doc, draft.update)

    expect(draft.sources).toEqual([PIXEL])
  })

  it('用户点掉的那张，只要还选着就不会被选区变化塞回来', () => {
    const doc = canvas([image('canvas-1', 'file-1'), image('canvas-2', 'file-2')])
    const selection = createSelectionReferences()
    const draft = drafts()

    doc.setSelection(['canvas-1'])
    selection.follow(doc, draft.update)
    expect(draft.ids).toEqual(['canvas-1'])
    // 用户点 × 把它从引用区拿掉，画布上它还选着。
    draft.update((current) => removeReference(current, 0))

    // 加选另一张：选区变了，但被拒绝过的那张不该跟着回来。
    doc.setSelection(['canvas-1', 'canvas-2'])
    selection.follow(doc, draft.update)

    expect(draft.ids).toEqual(['canvas-2'])
  })

  it('点掉后取消选中再选回来，算一次新的选择，重新自动带入', () => {
    const doc = canvas([image('canvas-1', 'file-1'), image('canvas-2', 'file-2')])
    const selection = createSelectionReferences()
    const draft = drafts()

    doc.setSelection(['canvas-1'])
    selection.follow(doc, draft.update)
    draft.update((current) => removeReference(current, 0))
    doc.setSelection(['canvas-1', 'canvas-2'])
    selection.follow(doc, draft.update)
    expect(draft.ids).toEqual(['canvas-2'])

    // 取消选中就翻篇。
    doc.setSelection(['canvas-2'])
    selection.follow(doc, draft.update)
    doc.setSelection(['canvas-1', 'canvas-2'])
    selection.follow(doc, draft.update)

    expect(draft.ids).toEqual(['canvas-2', 'canvas-1'])
  })

  it('点掉后又手动 `@` 回来的那张不归选区管，取消选中也留着', () => {
    const doc = canvas([image('canvas-1', 'file-1'), image('canvas-2', 'file-2')])
    const selection = createSelectionReferences()
    const draft = drafts()

    doc.setSelection(['canvas-1'])
    selection.follow(doc, draft.update)
    draft.update((current) => removeReference(current, 0))
    doc.setSelection(['canvas-1', 'canvas-2'])
    selection.follow(doc, draft.update)
    expect(draft.ids).toEqual(['canvas-2'])

    // 用户自己把它 `@` 回来了：这是手动引用。
    draft.update(
      (current) => attachReference(current, { id: 'canvas-1', dataUrl: PIXEL }, 0, 0).draft,
    )
    doc.setSelection([])
    selection.follow(doc, draft.update)

    expect(draft.ids).toEqual(['canvas-1'])
  })

  it('发送把草稿整份收走不算用户拒绝，仍选着的图下次照样带进来', () => {
    const doc = canvas([image('canvas-1', 'file-1'), image('canvas-2', 'file-2')])
    const selection = createSelectionReferences()
    const draft = drafts()

    doc.setSelection(['canvas-1'])
    selection.follow(doc, draft.update)
    // 乐观发送：输入框连同引用区一起清空。
    draft.update(() => EMPTY_DRAFT)
    selection.sent()

    doc.setSelection(['canvas-1', 'canvas-2'])
    selection.follow(doc, draft.update)

    expect(draft.ids).toEqual(['canvas-2', 'canvas-1'])
  })

  it('换一份草稿就清空自己的记账：上一份的自动引用不会撤走新草稿里手动 `@` 的同一张', () => {
    const doc = canvas([image('canvas-1', 'file-1'), image('canvas-2', 'file-2')])
    const selection = createSelectionReferences()
    const first = drafts()

    doc.setSelection(['canvas-1'])
    selection.follow(doc, first.update, undefined, 'draft:a')
    expect(first.ids).toEqual(['canvas-1'])

    // 切会话：新草稿里同一张图是用户手动 `@` 进来的，而且现在没选中。
    const second = drafts({ prompt: '', references: [{ id: 'canvas-1', dataUrl: PIXEL }] })
    doc.setSelection([])
    selection.follow(doc, second.update, undefined, 'draft:b')

    expect(second.ids).toEqual(['canvas-1'])
  })

  it('草稿没换就照旧：自动带进来的那张取消选中还是要撤走', () => {
    const doc = canvas()
    const selection = createSelectionReferences()
    const draft = drafts()

    doc.setSelection(['canvas-1'])
    selection.follow(doc, draft.update, undefined, 'draft:a')
    expect(draft.ids).toEqual(['canvas-1'])

    doc.setSelection([])
    selection.follow(doc, draft.update, undefined, 'draft:a')

    expect(draft.ids).toEqual([])
  })

  it('输入框重挂后，草稿里自动带进来的那张照旧跟着选区走', () => {
    const doc = canvas([image('canvas-1', 'file-1'), image('canvas-2', 'file-2')])
    const draft = drafts()

    doc.setSelection(['canvas-1'])
    createSelectionReferences().follow(doc, draft.update, undefined, 'draft:a')
    // 切走再切回来：输入框是新挂的，记账跟着归零，草稿还是原来那份。
    const remounted = createSelectionReferences()
    doc.setSelection(['canvas-2'])
    remounted.follow(doc, draft.update, undefined, 'draft:a')

    expect(draft.ids).toEqual(['canvas-2'])
  })

  it('发送失败放回来的草稿，自动带进来的那张照旧跟着选区走', () => {
    const doc = canvas([image('canvas-1', 'file-1'), image('canvas-2', 'file-2')])
    const selection = createSelectionReferences()
    const draft = drafts()

    doc.setSelection(['canvas-1'])
    selection.follow(doc, draft.update)
    const snapshot = draft.current
    draft.update(() => EMPTY_DRAFT)
    selection.sent()
    // 服务端没收下，整份草稿原样放回。
    draft.update(() => snapshot)

    doc.setSelection(['canvas-2'])
    selection.follow(doc, draft.update)

    expect(draft.ids).toEqual(['canvas-2'])
  })

  it('输入框重挂后，用户手动 `@` 的那张仍不归选区管', () => {
    const doc = canvas([image('canvas-1', 'file-1'), image('canvas-2', 'file-2')])
    const draft = drafts()

    doc.setSelection(['canvas-2'])
    createSelectionReferences().follow(doc, draft.update, undefined, 'draft:a')
    draft.update(
      (current) => attachReference(current, { id: 'canvas-1', dataUrl: PIXEL }, 0, 0).draft,
    )
    const remounted = createSelectionReferences()
    doc.setSelection([])
    remounted.follow(doc, draft.update, undefined, 'draft:a')

    expect(draft.ids).toEqual(['canvas-1'])
  })

  it('选区的钥匙认批注：图没换、圈的地方换了也算变了', () => {
    const doc = canvas([image('canvas-1', 'file-1'), CIRCLE])
    const selection = createSelectionReferences()

    doc.setSelection(['canvas-1'])
    const alone = selection.key(doc)
    doc.setSelection(['canvas-1', 'circle'])

    expect(selection.key(doc)).not.toBe(alone)
  })
})
