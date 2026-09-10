import { describe, expect, it } from 'vitest'
import {
  type AgentDraft,
  type AgentReference,
  attachReference,
  draftForSubmit,
  EMPTY_DRAFT,
  referenceLabels,
  removeReference,
} from '../../../features/agent/lib/references'
import { getVisiblePrompt } from '../../../lib/promptImageMentions'

const CANVAS: AgentReference = { id: 'canvas-1', dataUrl: 'data:image/png;base64,aGk=' }
const ASSET: AgentReference = {
  id: 'img-cat',
  dataUrl: 'data:image/png;base64,Y2F0',
  name: '橘猫产品图',
}

function visible(draft: AgentDraft): string {
  return getVisiblePrompt(draft.prompt, referenceLabels(draft.references))
}

/** 光标停在末尾时插入：`@` 触发的那条路走的就是这个区间。 */
function append(draft: AgentDraft, reference: AgentReference) {
  const at = visible(draft).length
  return attachReference(draft, reference, at, at)
}

describe('智能体输入框的引用', () => {
  it('renders a canvas object as a numbered capsule', () => {
    const { draft, cursor } = append({ prompt: '把', references: [] }, CANVAS)

    expect(draft.references).toEqual([CANVAS])
    expect(visible(draft)).toBe('把@图1')
    expect(cursor).toBe('把@图1'.length)
  })

  it('leaves the cursor right after the capsule it just inserted', () => {
    const draft: AgentDraft = { prompt: '把 的背景换成浅木色', references: [] }

    // `@` 触发的区间是 [1, 2)：从 `@` 起、到光标止，胶囊顶掉这一段。
    const { draft: next, cursor } = attachReference(draft, CANVAS, 1, 2)

    expect(visible(next)).toBe('把@图1的背景换成浅木色')
    expect(cursor).toBe('把@图1'.length)
  })

  it('keeps the cursor in place when a named asset makes the capsule longer', () => {
    const first = append(EMPTY_DRAFT, CANVAS)
    const draft: AgentDraft = { ...first.draft, prompt: `${first.draft.prompt}和@` }

    const { draft: next, cursor } = attachReference(draft, ASSET, 4, 5)

    expect(visible(next)).toBe('@图1和@橘猫产品图')
    expect(cursor).toBe('@图1和@橘猫产品图'.length)
  })

  it('labels a library asset by its name', () => {
    const { draft } = append(EMPTY_DRAFT, ASSET)

    expect(visible(draft)).toBe('@橘猫产品图')
  })

  it('reuses the same number when the same image is referenced twice', () => {
    const first = append(EMPTY_DRAFT, CANVAS)
    const second = append({ ...first.draft, prompt: `${first.draft.prompt} 和 ` }, CANVAS)

    expect(second.draft.references).toEqual([CANVAS])
    expect(visible(second.draft)).toBe('@图1 和 @图1')
  })

  it('numbers a second distinct image after the first', () => {
    const first = append(EMPTY_DRAFT, CANVAS)
    const second = append({ ...first.draft, prompt: `${first.draft.prompt} 换成 ` }, ASSET)

    expect(second.draft.references.map((one) => one.id)).toEqual(['canvas-1', 'img-cat'])
    expect(visible(second.draft)).toBe('@图1 换成 @橘猫产品图')
  })

  it('downgrades a removed reference and renumbers the rest', () => {
    const first = append(EMPTY_DRAFT, CANVAS)
    const second = append({ ...first.draft, prompt: `${first.draft.prompt} 换成 ` }, ASSET)

    const left = removeReference(second.draft, 0)

    expect(left.references.map((one) => one.id)).toEqual(['img-cat'])
    expect(visible(left)).toBe('@已移除图片 换成 @橘猫产品图')
  })

  it('still submits the turn after a reference was removed', () => {
    const first = append(EMPTY_DRAFT, CANVAS)
    const second = append({ ...first.draft, prompt: `${first.draft.prompt} 换成 ` }, ASSET)

    const submission = draftForSubmit(removeReference(second.draft, 0))

    expect(submission.text).toBe('@已移除图片 换成 [image 1]')
    expect(submission.references).toEqual([
      { imageId: 'img-cat', dataUrl: ASSET.dataUrl, name: '橘猫产品图' },
    ])
  })

  it('sends capsules as numbered references', () => {
    const first = append({ prompt: '把', references: [] }, CANVAS)
    const second = append({ ...first.draft, prompt: `${first.draft.prompt} 改成 ` }, ASSET)

    expect(draftForSubmit(second.draft)).toEqual({
      text: '把[image 1] 改成 [image 2]',
      references: [
        { imageId: 'canvas-1', dataUrl: CANVAS.dataUrl },
        { imageId: 'img-cat', dataUrl: ASSET.dataUrl, name: '橘猫产品图' },
      ],
    })
  })

  it('carries a mask drawn on the referenced image', () => {
    const { draft } = append(EMPTY_DRAFT, { ...CANVAS, maskDataUrl: 'data:image/png;base64,bQ==' })

    expect(draftForSubmit(draft).references[0]!.maskDataUrl).toBe('data:image/png;base64,bQ==')
  })
})
