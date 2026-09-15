import type { AgentCanvasSink, AgentPlaceOutcome } from '../../agent/lib/canvasSink'
import type { CanvasEditor } from './editor'
import { markPlaceholderStatus, placeImagesIntoTargets } from './placeholderShapeOps'
import { computePlaceholderTargets, type PlacementTarget } from './placement'

/** 结果卡缩略图的缩放比。画布对象通常 360 页面单位宽，缩到面板里够看。 */
const THUMBNAIL_SCALE = 0.25

export function createAgentCanvasSink(
  editor: CanvasEditor,
  ready?: Promise<unknown> | (() => Promise<unknown>),
): AgentCanvasSink {
  // 面板折叠一次、切一次页签，每张卡都会重新问一遍缩略图；栅格化不便宜，存下来。
  const thumbnails = new Map<string, string>()

  const anchorBounds = (anchorObjectId: string | undefined) =>
    anchorObjectId ? (editor.getElementPageBounds(anchorObjectId) ?? null) : null

  return {
    get ready() {
      return typeof ready === 'function' ? ready() : ready
    },
    has: (objectId) => editor.getElement(objectId) !== undefined,

    revision: () => editor.editRevision(),

    async reserve({ count, anchorObjectId }) {
      if (ready) await (typeof ready === 'function' ? ready() : ready)
      if (count <= 0) return []
      // history: false —— 智能体的占位框不是用户编辑，抬了 editRevision 它会判自己冲突。
      const ids = computePlaceholderTargets(editor, anchorBounds(anchorObjectId), count).map(
        (target) =>
          editor.createPlaceholder(
            target,
            {
              taskId: '',
              clientRequestId: '',
              source: 'builtin-edge',
              prompt: '',
              agent: true,
            },
            { history: false },
          ),
      )
      // 产出落在视口外用户根本不知道这一轮干了什么，所以占位一建好就把镜头带过去。
      editor.scrollToElements(ids)
      return ids
    },

    discard(placeholderIds) {
      for (const id of placeholderIds) editor.deleteElement(id, { history: false })
    },

    markFailed(placeholderIds, message) {
      for (const id of placeholderIds) markPlaceholderStatus(editor, id, 'error', message)
    },

    async place(artifacts, options) {
      if (ready) await (typeof ready === 'function' ? ready() : ready)
      let outcome: AgentPlaceOutcome = 'placed'
      const canPlace = () => {
        const base = options?.baseRevision
        outcome =
          options?.isCurrent && !options.isCurrent()
            ? 'unavailable'
            : base !== undefined && editor.editRevision() !== base
              ? 'conflict'
              : 'placed'
        return outcome === 'placed'
      }
      if (!canPlace()) return outcome
      const missing = artifacts.filter((artifact) => !editor.getElement(artifact.artifactId))
      if (missing.length === 0) return 'placed'
      // 起跑时占下的位还在就用它的几何：用户看着那个框转圈，产物就该落进那个框。
      const reserved = (options?.placeholderIds ?? []).filter((id) => editor.getPlaceholder(id))
      const bounds = anchorBounds(options?.anchorObjectId)
      const targets: PlacementTarget[] = reserved
        .slice(0, missing.length)
        .map((id) => editor.getPlaceholder(id)!)
        .map((view) => ({ x: view.x, y: view.y, w: view.w, h: view.h }))
      // 占位框不够（续播只收到尾巴、或上游多给了几张）：余下的现找空位，产物不能丢。
      if (targets.length < missing.length) {
        targets.push(...computePlaceholderTargets(editor, bounds, missing.length - targets.length))
      }
      await placeImagesIntoTargets(
        editor,
        missing.map((artifact) => ({
          dataUrl: artifact.dataUrl,
          id: artifact.artifactId,
          ...(artifact.video ? { video: artifact.video } : {}),
        })),
        targets,
        { canPlace },
      )
      // 落图成功才收占位框：中途被判冲突时它得留着，用户点「放入画布」还认得这个位置。
      if (outcome === 'placed') {
        for (const id of reserved) editor.deleteElement(id, { history: false })
      }
      return outcome
    },

    focus(objectIds) {
      const present = objectIds.filter((id) => editor.getElement(id))
      if (present.length === 0) return
      editor.setSelectedElements(present)
      editor.scrollToElements(present)
    },

    async thumbnail(objectId) {
      if (ready) await (typeof ready === 'function' ? ready() : ready)
      const cached = thumbnails.get(objectId)
      if (cached) return cached
      const rendered = await editor.toImage([objectId], { scale: THUMBNAIL_SCALE })
      if (rendered) thumbnails.set(objectId, rendered)
      return rendered
    },
  }
}
