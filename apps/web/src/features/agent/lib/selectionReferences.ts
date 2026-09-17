import type { CanvasDoc, ImageEl } from '../../canvas/lib/canvasDoc'
import { type MarkRenderer, renderMarkedImage, selectedMarkIds } from './markedReferences'
import { type AgentDraft, removeReference } from './references'

/** 画布上选中的一张图，连同压在它上面、也被选中的批注。 */
interface SelectedImage {
  readonly imageId: string
  readonly element: ImageEl
  readonly dataUrl: string
  readonly marks: readonly string[]
}

/**
 * 选中的画布图，最上层的排在最前——引用区的次序跟着图层走。没有位图的对象不算数：
 * 引用得有图可带。
 */
function selectedImages(doc: CanvasDoc): SelectedImage[] {
  const images = doc.elements.filter((element): element is ImageEl => element.type === 'image')
  return images.reverse().flatMap((element) => {
    if (!doc.selection.has(element.id)) return []
    const dataUrl = doc.files[element.fileId]
    if (!dataUrl) return []
    return [{ imageId: element.id, element, dataUrl, marks: selectedMarkIds(doc, element) }]
  })
}

interface Synced {
  readonly draft: AgentDraft
  readonly auto: ReadonlySet<string>
}

/**
 * 让引用区跟着画布选区走。选中、草稿里还没有的加进来并记为自动带的；记为自动带的、
 * 现在又没选中的撤掉（指向它的引用降级）。用户手动 `@` 进来的一律不动。
 */
function syncSelected(
  draft: AgentDraft,
  selected: readonly SelectedImage[],
  auto: ReadonlySet<string>,
): Synced {
  const ids = new Set(selected.map((one) => one.imageId))
  const next = new Set(auto)
  let result = draft
  for (const id of auto) {
    if (ids.has(id)) continue
    next.delete(id)
    const index = result.references.findIndex((one) => one.id === id)
    if (index >= 0) result = removeReference(result, index)
  }
  for (const image of selected) {
    const at = result.references.findIndex((one) => one.id === image.imageId)
    if (at >= 0) {
      // 自动带进来的回到原图（批注取消了）；用户手动 `@` 的不动。
      if (!next.has(image.imageId) || result.references[at]!.dataUrl === image.dataUrl) continue
      result = withDataUrl(result, image.imageId, image.dataUrl)
      continue
    }
    next.add(image.imageId)
    result = {
      ...result,
      references: [...result.references, { id: image.imageId, dataUrl: image.dataUrl }],
    }
  }
  return { draft: result, auto: next }
}

/** 换掉某张自动带进来的参考图的位图；手动 `@` 的那张不归选区管，原样返回。 */
function withDataUrl(draft: AgentDraft, id: string, dataUrl: string): AgentDraft {
  return {
    ...draft,
    references: draft.references.map((one) => (one.id === id ? { ...one, dataUrl } : one)),
  }
}

export interface SelectionReferences {
  /**
   * 谁被选中、各自压着哪些批注。这就是「值不值得再同步一次」的判据：它没变就别叫
   * `follow`——画布内容变一次同步一次，会把用户手动移掉的参考图又加回来。
   */
  key(doc: CanvasDoc): string
  /**
   * 把引用区带到 `doc` 当下的选区：先按原图同步（批注一取消立刻回到原图），
   * 选中的图上压着批注的，烧一张带批注的版本随后替换回来。替换落地前选区又变了就丢掉——
   * 那组批注已经不是用户圈的那组了。没有 `renderer` 就只带原图。
   */
  follow(
    doc: CanvasDoc,
    update: (change: (draft: AgentDraft) => AgentDraft) => void,
    renderer?: MarkRenderer,
  ): void
}

/**
 * 「哪些引用是跟着选区自动带进来的」归这里管：auto 集合是本模块的私有状态，
 * 调用方拿到的只是一个句柄。它跟着输入框的挂载周期活，不进草稿、不持久化。
 */
export function createSelectionReferences(): SelectionReferences {
  let auto: ReadonlySet<string> = new Set()
  let current: string | undefined

  return {
    key(doc) {
      return selectionKey(selectedImages(doc))
    },

    follow(doc, update, renderer) {
      const selected = selectedImages(doc)
      const key = selectionKey(selected)
      current = key
      update((draft) => {
        const synced = syncSelected(draft, selected, auto)
        auto = synced.auto
        return synced.draft
      })
      if (!renderer) return
      for (const image of selected) {
        if (image.marks.length === 0) continue
        void renderMarkedImage(renderer, image.element, image.marks).then((dataUrl) => {
          if (!dataUrl || current !== key) return
          update((draft) =>
            auto.has(image.imageId) ? withDataUrl(draft, image.imageId, dataUrl) : draft,
          )
        })
      }
    },
  }
}

function selectionKey(selected: readonly SelectedImage[]): string {
  return selected.map((one) => `${one.imageId}:${one.marks.join(',')}`).join(' ')
}
