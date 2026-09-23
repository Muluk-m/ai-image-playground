import { AGENT_TURN_MAX_REFERENCES } from '@image-playground/shared'
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
  readonly dismissed: ReadonlySet<string>
  /** 选中却没能进引用区的张数：本轮的参考图已经满了。 */
  readonly overflow: number
}

/**
 * 让引用区跟着画布选区走。选中、草稿里还没有的加进来并记为自动带的；记为自动带的、
 * 现在又没选中的撤掉（指向它的引用降级）。用户手动 `@` 进来的一律不动。
 *
 * 自动带进来的那张还选着、草稿里却没了，只能是用户点掉的：记成拒绝过，往后的选区
 * 变化不再把它塞回去，取消选中才算翻篇。
 *
 * 「自动带的」除了本模块记下的，还认草稿里标着 `origin: 'selection'` 的：输入框重挂、
 * 发送失败放回来的草稿，本模块的记账已经归零，只有草稿自己还记得。
 *
 * 一轮最多带 `AGENT_TURN_MAX_REFERENCES` 张：服务端对这个数量是硬校验，超出去的那几张
 * 会让整轮起轮以 400 被打回。放不下的既不进草稿也不记账——腾出位置后下一次同步再带进来。
 */
function syncSelected(
  draft: AgentDraft,
  selected: readonly SelectedImage[],
  remembered: ReadonlySet<string>,
  dismissed: ReadonlySet<string>,
): Synced {
  const ids = new Set(selected.map((one) => one.imageId))
  const auto = new Set(remembered)
  for (const one of draft.references) if (one.origin === 'selection') auto.add(one.id)
  const next = new Set(auto)
  // 取消选中就翻篇：下次再选中它算一次新的选择。
  const refused = new Set([...dismissed].filter((id) => ids.has(id)))
  let result = draft
  for (const id of auto) {
    if (ids.has(id)) {
      if (result.references.some((one) => one.id === id)) continue
      next.delete(id)
      refused.add(id)
      continue
    }
    next.delete(id)
    const index = result.references.findIndex((one) => one.id === id)
    if (index >= 0) result = removeReference(result, index)
  }
  let overflow = 0
  for (const image of selected) {
    if (refused.has(image.imageId)) continue
    const at = result.references.findIndex((one) => one.id === image.imageId)
    if (at >= 0) {
      // 自动带进来的回到原图（批注取消了）；用户手动 `@` 的不动。
      if (!next.has(image.imageId) || result.references[at]!.dataUrl === image.dataUrl) continue
      result = withDataUrl(result, image.imageId, image.dataUrl)
      continue
    }
    if (result.references.length >= AGENT_TURN_MAX_REFERENCES) {
      overflow += 1
      continue
    }
    next.add(image.imageId)
    result = {
      ...result,
      references: [
        ...result.references,
        { id: image.imageId, dataUrl: image.dataUrl, origin: 'selection' },
      ],
    }
  }
  return { draft: result, auto: next, dismissed: refused, overflow }
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
   *
   * `scope` 是这份草稿的身份。这套记账只对当初那份草稿成立，`scope` 一变先全部归零再同步：
   * 换了草稿还拿旧账去对，同一个 id 在新草稿里被手动 `@` 过就会被当成自动引用撤走。
   *
   * 返回这次因为满了没带进去的张数，调用方据此告诉用户；0 表示选区整个带上了。
   */
  follow(
    doc: CanvasDoc,
    update: (change: (draft: AgentDraft) => AgentDraft) => void,
    renderer?: MarkRenderer,
    scope?: string,
  ): number
  /**
   * 草稿整份被发送收走了。引用区跟着空掉不是用户在拒绝，所以只作废 auto 记账，
   * 仍选中的图下一次同步照常带回来；用户拒绝过的那几张仍然算数。发送失败放回来的草稿
   * 靠引用上的 `origin` 认回自动带的那几张。
   */
  sent(): void
}

/**
 * 「哪些引用是跟着选区自动带进来的」归这里管：auto 与 dismissed 两个集合是本模块的私有状态，
 * 调用方拿到的只是一个句柄。这两本账跟着输入框的挂载周期活；活得比它久的那一半——
 * 哪张是自动带的——写在草稿里的引用上（`origin`），随草稿落盘。
 */
export function createSelectionReferences(): SelectionReferences {
  let auto: ReadonlySet<string> = new Set()
  let dismissed: ReadonlySet<string> = new Set()
  let current: string | undefined
  let scoped: string | undefined

  return {
    key(doc) {
      return selectionKey(selectedImages(doc))
    },

    sent() {
      auto = new Set()
    },

    follow(doc, update, renderer, scope) {
      if (scope !== scoped) {
        scoped = scope
        auto = new Set()
        dismissed = new Set()
      }
      const selected = selectedImages(doc)
      const key = selectionKey(selected)
      current = key
      let overflow = 0
      update((draft) => {
        const synced = syncSelected(draft, selected, auto, dismissed)
        auto = synced.auto
        dismissed = synced.dismissed
        overflow = synced.overflow
        return synced.draft
      })
      if (!renderer) return overflow
      for (const image of selected) {
        if (image.marks.length === 0) continue
        void renderMarkedImage(renderer, image.element, image.marks).then((dataUrl) => {
          if (!dataUrl || current !== key) return
          update((draft) =>
            auto.has(image.imageId) ? withDataUrl(draft, image.imageId, dataUrl) : draft,
          )
        })
      }
      return overflow
    },
  }
}

function selectionKey(selected: readonly SelectedImage[]): string {
  return selected.map((one) => `${one.imageId}:${one.marks.join(',')}`).join(' ')
}
