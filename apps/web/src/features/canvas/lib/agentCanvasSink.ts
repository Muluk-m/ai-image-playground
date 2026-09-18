import { type AgentToolErrorCode, PROJECT_META_VALUE_MAX_CHARS } from '@image-playground/shared'
import { i18next } from '../../../i18n'
import type {
  AgentCanvasSink,
  AgentPlaceOutcome,
  AgentReservation,
} from '../../agent/lib/canvasSink'
import type { CanvasEditor } from './editor'
import { markPlaceholderStatus, placeImagesIntoTargets } from './placeholderShapeOps'
import { computePlaceholderTargets, type PlacementTarget } from './placement'
import { recoverVideoPoster } from './recoverVideoPoster'

/** 结果卡缩略图的缩放比。画布对象通常 360 页面单位宽，缩到面板里够看。 */
const THUMBNAIL_SCALE = 0.25

/**
 * 提交前就被拒的失败：任务根本没进队列，服务端也就没在云端项目里预留位置。云端项目上这几类
 * 只能由本机补一个失败占位，否则去充值 / 去登录 / 让助手重新处理在云端项目上永远看不见。
 * 其余的码（上游出错、超时、没出图、结果未知）来自已受理的任务，由服务端把预留位置留作失败占位。
 */
const REFUSED_BEFORE_SUBMISSION: ReadonlySet<AgentToolErrorCode> = new Set([
  'insufficient_credits',
  'quota_exceeded',
  'authentication_required',
  'invalid_params',
  'model_unavailable',
])

/** 云端项目图片调用的占位凭据：画布上没有对应元素，只记着失败时在哪、为谁补失败占位。 */
const DEFERRED_PREFIX = 'agent-cloud-deferred:'

export function createAgentCanvasSink(
  editor: CanvasEditor,
  ready?: Promise<unknown> | (() => Promise<unknown>),
  cloud?: { enabled(): boolean; refresh(): Promise<void> },
): AgentCanvasSink {
  // 面板折叠一次、切一次页签，每张卡都会重新问一遍缩略图；栅格化不便宜，存下来。
  const thumbnails = new Map<string, string>()
  // 云端项目图片调用起跑时记下的占位请求，按凭据取；失败补占位或被收掉时移除。
  const deferred = new Map<string, AgentReservation>()

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
        // 云端项目的图片占位由服务端在受理任务时预留；本机只记下请求，提交就被拒时拿它补失败占位。
        const token = `${DEFERRED_PREFIX}${crypto.randomUUID()}`
        deferred.set(token, request)
        return [token]
      }
      if (messageId) {
        const existing = editor
          .getPlaceholders()
          .filter((one) => one.meta.agentMessageId === messageId)
        if (existing.length) return existing.map((one) => one.id)
      }
      const ids = createPlaceholders(request)
      // 产出落在视口外用户根本不知道这一轮干了什么，所以占位一建好就把镜头带过去。
      editor.scrollToElements(ids)
      return ids
    },

    discard(placeholderIds) {
      for (const id of placeholderIds) {
        if (deferred.delete(id)) continue
        editor.deleteElement(id, { history: false })
      }
    },

    markFailed(ids, message, errorCode) {
      const refusals = ids.flatMap((id) => {
        const request = deferred.get(id)
        deferred.delete(id)
        return request ? [request] : []
      })
      const placeholderIds = ids.filter((id) => !id.startsWith(DEFERRED_PREFIX))
      // 云端项目的图片占位由服务端预留，失败时服务端把它留作失败占位；立即拉一次，
      // 不等下一轮轮询才让它从「生成中」变过来。
      if (cloud?.enabled()) void cloud.refresh().catch(() => {})
      // 提交就被拒时服务端没留位置：本机补一个只在这台设备上的失败占位（不进云端文档），
      // 让它和本机项目一样按码给出路。
      if (errorCode && REFUSED_BEFORE_SUBMISSION.has(errorCode)) {
        const created = refusals.flatMap((request) => {
          // 续播重放同一次失败的调用：这台设备上已经补过的占位就用它，不再叠一个。
          const existing = request.messageId
            ? editor
                .getPlaceholders()
                .filter((one) => one.meta.agentMessageId === request.messageId)
            : []
          return existing.length ? existing.map((one) => one.id) : createPlaceholders(request)
        })
        placeholderIds.push(...created)
        if (created.length) editor.scrollToElements(created)
      }
      for (const id of placeholderIds) {
        if (errorCode)
          editor.updatePlaceholder(id, {
            status: 'error',
            message,
            meta: { agentErrorCode: errorCode },
          })
        else markPlaceholderStatus(editor, id, 'error', message)
      }
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

    focus(objectIds) {
      const present = objectIds.filter((id) => editor.getElement(id))
      if (present.length === 0) return
      editor.setSelectedElements(present)
      editor.scrollToElements(present)
    },

    async thumbnail(objectId) {
      if (ready) await (typeof ready === 'function' ? ready() : ready)
      await recoverVideoPoster(editor, objectId)
      const element = editor.getElement(objectId)
      const cacheKey = element?.type === 'image' ? `${objectId}:${element.fileId}` : objectId
      const cached = thumbnails.get(cacheKey)
      if (cached) return cached
      const rendered = await editor.toImage([objectId], { scale: THUMBNAIL_SCALE })
      if (rendered) thumbnails.set(cacheKey, rendered)
      return rendered
    },
  }
}
