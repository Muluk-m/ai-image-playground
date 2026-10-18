import {
  type AgentCanvasEdit,
  type AgentToolErrorCode,
  PROJECT_META_VALUE_MAX_CHARS,
} from '@image-playground/shared'
import { i18next } from '../../../i18n'
import type {
  AgentCanvasSink,
  AgentPlaceOutcome,
  AgentReservation,
} from '../../agent/lib/canvasSink'
import type { CanvasEditor } from './editor'
import { focusNodeCanvas, revealNodeCanvas } from './nodeCanvasFocus'
import { markPlaceholderStatus, placeImagesIntoTargets } from './placeholderShapeOps'
import { computePlaceholderTargets, type PlacementTarget } from './placement'
import { recoverVideoPoster } from './recoverVideoPoster'
import { placeTimelinePlan } from './timeline'

/** 结果卡缩略图的缩放比。画布对象通常 360 页面单位宽，缩到面板里够看。 */
const THUMBNAIL_SCALE = 0.25

export function createAgentCanvasSink(
  editor: CanvasEditor,
  ready?: Promise<unknown> | (() => Promise<unknown>),
  cloud?: { enabled(): boolean; refresh(): Promise<void> },
): AgentCanvasSink {
  // 面板折叠一次、切一次页签，每张卡都会重新问一遍缩略图；栅格化不便宜，存下来。
  const thumbnails = new Map<string, string>()

  const anchorBounds = (anchorObjectId: string | undefined) =>
    anchorObjectId ? (editor.getElementPageBounds(anchorObjectId) ?? null) : null

  const createPlaceholders = ({
    count,
    anchorObjectId,
    title,
    messageId,
    conversationId,
  }: AgentReservation) => {
    const groupId = crypto.randomUUID()
    return computePlaceholderTargets(editor, anchorBounds(anchorObjectId), count).map((target) =>
      // history: false —— 智能体的占位框是机器搭的脚手架，不是用户编辑，不该进 undo 栈。
      editor.createPlaceholder(
        target,
        {
          taskId: '',
          clientRequestId: groupId,
          source: 'builtin-edge',
          prompt: title ?? '',
          agent: true,
          agentMessageId: messageId,
          ...(conversationId ? { agentConversationId: conversationId } : {}),
        },
        { history: false },
      ),
    )
  }

  return {
    get ready() {
      return typeof ready === 'function' ? ready() : ready
    },
    has: (objectId) => editor.getElement(objectId)?.type === 'image',
    async syncArtifacts(artifacts) {
      if (ready) await (typeof ready === 'function' ? ready() : ready)
      if (!cloud?.enabled() || artifacts.some((artifact) => artifact.media === 'video')) return null
      await cloud.refresh()
      return artifacts.every((artifact) => editor.getElement(artifact.artifactId)?.type === 'image')
        ? 'placed'
        : 'unavailable'
    },

    async reserve(request) {
      if (ready) await (typeof ready === 'function' ? ready() : ready)
      const { count, messageId, media } = request
      if (count <= 0) return []
      if (cloud?.enabled() && media !== 'video') {
        // 云端图片由服务端预留；提交前拒绝由对话卡片给出处理入口。
        return []
      }
      if (messageId) {
        const existing = editor
          .getPlaceholders()
          .filter((one) => one.meta.agentMessageId === messageId)
        if (existing.length) return existing.map((one) => one.id)
      }
      const ids = createPlaceholders(request)
      // 产出落在视口外用户根本不知道这一轮干了什么，所以占位一建好就把镜头带过去。
      if (!revealNodeCanvas(editor, ids)) editor.scrollToElements(ids)
      return ids
    },

    discard(placeholderIds) {
      for (const id of placeholderIds) {
        editor.deleteElement(id, { history: false })
      }
    },

    markFailed(ids, message, errorCode) {
      // 云端项目的图片占位由服务端预留，失败时服务端把它留作失败占位；立即拉一次，
      // 不等下一轮轮询才让它从「生成中」变过来。
      if (cloud?.enabled()) void cloud.refresh().catch(() => {})
      for (const id of ids) {
        // 云端失败占位的失败状态归服务端写（本机改了它，保存会被拒）；拉回来的就是它的终局。
        if (editor.getPlaceholder(id)?.meta.cloudGeneration) continue
        if (errorCode)
          editor.updatePlaceholder(id, {
            status: 'error',
            message,
            meta: { agentErrorCode: errorCode },
          })
        else markPlaceholderStatus(editor, id, 'error', message)
      }
    },

    async revive(ids) {
      let pull = false
      for (const id of ids) {
        const placeholder = editor.getPlaceholder(id)
        if (!placeholder) continue
        // 云端的失败占位不能由本机改回生成中（服务端会拒绝这次保存）：它已被服务端换掉，拉回来即可。
        if (placeholder.meta.cloudGeneration) {
          pull = true
          continue
        }
        editor.updatePlaceholder(id, { status: 'loading', message: '' })
      }
      // 拉不下来也不卡住：下一次轮询会把它换过来，服务端对同一个占位的重复重试只给回原来那条。
      if (pull) await cloud?.refresh().catch(() => {})
    },

    async place(artifacts, options) {
      if (ready) await (typeof ready === 'function' ? ready() : ready)
      let outcome: AgentPlaceOutcome = 'placed'
      const canPlace = () => {
        outcome = options?.isCurrent && !options.isCurrent() ? 'unavailable' : 'placed'
        return outcome === 'placed'
      }
      if (!canPlace()) return outcome
      const missing = artifacts.filter((artifact) => !editor.getElement(artifact.artifactId))
      const allPlaced = () =>
        artifacts.every((artifact) => editor.getElement(artifact.artifactId)?.type === 'image')
      if (missing.length === 0) return allPlaced() ? 'placed' : 'unavailable'
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
          groupId: artifact.taskId,
          name: artifact.name,
          ...(artifact.video ? { video: artifact.video } : {}),
        })),
        targets,
        {
          canPlace,
          meta: {
            prompt:
              missing[0]?.name?.replace(/\s+\d+$/, '') ||
              i18next.t('creations.taskTitle', { ns: 'agent' }),
            // 同一次调用的产物共用一条提示词；视频重新生成拿它预填。
            // 云端项目的 meta 值有长度上限，超长的记下来会让整个项目同步失败；宁可不记。
            ...(missing[0]?.prompt && missing[0].prompt.length <= PROJECT_META_VALUE_MAX_CHARS
              ? { userPrompt: missing[0].prompt }
              : {}),
          },
        },
      )
      if (outcome === 'placed' && !allPlaced()) return 'unavailable'
      // 落图成功才收占位框：中途画布离开时它得留着，用户点「放入画布」还认得这个位置。
      if (outcome === 'placed') {
        for (const id of reserved) editor.deleteElement(id, { history: false })
      }
      return outcome
    },

    async placeTimeline(plan) {
      if (ready) await (typeof ready === 'function' ? ready() : ready)
      return placeTimelinePlan(editor, plan) ? 'placed' : 'unavailable'
    },

    /**
     * 按计划给已有图片元素打补丁。只认 image：生成占位与产物由服务端登记，客户端改一个字
     * 整份保存都会被服务端的逐字核对拒掉（`apps/bff/src/lib/projects.ts`）。
     *
     * 进 undo 栈——这是用户看得见的编辑，不是机器搭的脚手架（与占位框的 `history:false` 相反），
     * 改错了要能一步撤回。
     */
    async editElements(plan) {
      if (ready) await (typeof ready === 'function' ? ready() : ready)
      const patches = plan.edits.flatMap((one: AgentCanvasEdit) => {
        const element = editor.getElement(one.elementId)
        if (element?.type !== 'image') return []
        const { elementId: _id, section, ...rest } = one
        const patch: Partial<typeof element> = { ...rest }
        if (section !== undefined) {
          const meta = { ...element.meta }
          if (section === '') delete meta.section
          else meta.section = section
          patch.meta = Object.keys(meta).length > 0 ? meta : undefined
        }
        return Object.keys(patch).length > 0 ? [{ id: one.elementId, patch }] : []
      })
      if (patches.length === 0) return 'unavailable'
      editor.doc.updateElements(patches, { history: true })
      return 'placed'
    },

    failedPlaceholders({ messageId, taskIds }) {
      return editor
        .getPlaceholders()
        .filter(
          (one) =>
            one.status === 'error' &&
            one.meta.agent === true &&
            (one.meta.agentMessageId === messageId ||
              (one.meta.cloudGeneration !== undefined &&
                taskIds.includes(one.meta.cloudGeneration.id))),
        )
        .map((one) => ({
          id: one.id,
          ...(one.meta.agentErrorCode ? { errorCode: one.meta.agentErrorCode } : {}),
          ...(one.meta.cloudGeneration ? { generationId: one.meta.cloudGeneration.id } : {}),
        }))
    },

    focus(objectIds) {
      if (focusNodeCanvas(editor, objectIds)) return
      const present = objectIds.filter((id) => editor.getElement(id))
      if (present.length === 0) return
      editor.setSelectedElements(present)
      editor.scrollToElements(present)
    },

    focusPending({ messageId, taskId }) {
      const ids = editor
        .getPlaceholders()
        .filter(
          (one) =>
            one.meta.agentMessageId === messageId ||
            (taskId !== undefined && one.meta.cloudGeneration?.id === taskId),
        )
        .map((one) => one.id)
      if (ids.length === 0) return false
      if (focusNodeCanvas(editor, ids)) return true
      editor.setSelectedElements(ids)
      editor.scrollToElements(ids)
      return true
    },

    async thumbnail(objectId, scale = THUMBNAIL_SCALE) {
      if (ready) await (typeof ready === 'function' ? ready() : ready)
      await recoverVideoPoster(editor, objectId)
      const element = editor.getElement(objectId)
      const cacheKey = `${element?.type === 'image' ? `${objectId}:${element.fileId}` : objectId}:${scale}`
      const cached = thumbnails.get(cacheKey)
      if (cached) return cached
      const rendered = await editor.toImage([objectId], { scale, background: 'transparent' })
      if (rendered) thumbnails.set(cacheKey, rendered)
      return rendered
    },
  }
}
