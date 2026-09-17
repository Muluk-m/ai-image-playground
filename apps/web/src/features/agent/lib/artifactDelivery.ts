import type { AgentToolArtifact } from '@image-playground/shared'
import { i18next } from '../../../i18n'
import { AGENT_CONVERSATION_KEY, scopedStorageName } from '../../../lib/authScope'
import type { AgentDeliveryStatus, AgentPanelMessage, AgentToolMessage } from '../types'
import { artifactBitmap } from './artifactSource'
import {
  type AgentCanvasSink,
  type AgentPlacedArtifact,
  type AgentReservation,
  agentCanvasSink,
} from './canvasSink'

interface DeliveryOrigin {
  readonly generation: number
  readonly scope: string
  readonly canvas: AgentCanvasSink | null
  pending: Promise<void>
  /** 每次工具调用在画布上占下的位，按那条结果卡的 messageId 索引。 */
  readonly reserved: Map<string, Promise<readonly string[]>>
}

interface DeliveryRecord {
  status: AgentDeliveryStatus
  pending: Promise<void>
}

export interface TurnArtifactDelivery {
  isCurrent(): boolean
  canContinue(): boolean
  /** 工具起跑：先在画布上占位，镜头跟过去。产物到了落进这些位。 */
  reserve(messageId: string, request: AgentReservation): void
  enqueue(message: AgentToolMessage): void
  /** 工具失败：占的位转错误态，不再转圈。 */
  failed(messageId: string, message: string | undefined): void
  /** 工具跑完了但没有产物：占的位直接收掉。 */
  discard(messageId: string): void
  settled(): Promise<void>
}

/** 位图问 `artifactSource` 要；这里只管视频落画布的是封面加播放来源，mp4 不下载到本地。 */
async function prepare(artifact: AgentToolArtifact): Promise<AgentPlacedArtifact> {
  const { artifactId, taskId, outputIndex } = artifact
  const dataUrl = await artifactBitmap(artifact)
  return artifact.media === 'video'
    ? { artifactId, dataUrl, video: { taskId, outputIndex } }
    : { artifactId, dataUrl }
}

/** 交付串行，文字流不等它；每轮持有原画布，持久化文档可在切换后完成交付。 */
export function createArtifactDelivery(
  changed: (messageId: string, status: AgentDeliveryStatus) => void,
) {
  let generation = 0
  let queue = Promise.resolve()
  const origins = new Set<DeliveryOrigin>()
  const records = new Map<string, DeliveryRecord>()
  const scope = () => scopedStorageName(AGENT_CONVERSATION_KEY)
  const belongs = (origin: DeliveryOrigin) =>
    origin.generation === generation && origin.scope === scope()
  const current = (origin: DeliveryOrigin) =>
    origin.scope === scope() &&
    origin.canvas !== null &&
    (origin.canvas.background === true || (belongs(origin) && agentCanvasSink() === origin.canvas))

  const capture = (): DeliveryOrigin => {
    const canvas = agentCanvasSink()
    const origin: DeliveryOrigin = {
      generation,
      scope: scope(),
      canvas,
      pending: Promise.resolve(),
      reserved: new Map(),
    }
    origins.add(origin)
    return origin
  }

  /** 取走某次调用占的位并从登记表移除：终局只能有一个处置者。 */
  const claim = (origin: DeliveryOrigin, messageId: string) => {
    const pending = origin.reserved.get(messageId)
    origin.reserved.delete(messageId)
    return pending
  }

  /**
   * 产物一到就落画布，不问用户中途动没动过画布：它落的是起跑时占好的位，
   * 盖不到别人的东西。以前的「画布有改动就不写、让用户手动放入」只会留下一个
   * 永远转圈的占位框和一张要人再点一下的卡。
   */
  const place = async (
    origin: DeliveryOrigin,
    message: AgentToolMessage,
    manual: boolean,
  ): Promise<AgentDeliveryStatus> => {
    const canvas = origin.canvas
    if (!canvas || !current(origin)) return 'unavailable'
    // 起跑时占的位先认领回来：它决定产物落在哪，也决定这一轮结束时谁该被收掉。
    const placeholderIds = (await claim(origin, message.id)) ?? []
    if (!manual && canvas.syncArtifacts) {
      const outcome = await canvas.syncArtifacts(message.artifacts ?? [])
      if (outcome !== null) {
        canvas.discard(placeholderIds)
        return current(origin) ? outcome : 'unavailable'
      }
    }
    const missing = (message.artifacts ?? []).filter((artifact) => !canvas.has(artifact.artifactId))
    if (!missing.length) {
      canvas.discard(placeholderIds)
      return 'placed'
    }
    const items = await Promise.all(
      missing.map(async (artifact) => ({
        ...(await prepare(artifact)),
        taskId: artifact.taskId,
        name: `${message.title || i18next.t('delivery.artifactName', { ns: 'agent' })} ${artifact.outputIndex + 1}`,
      })),
    )
    if (!current(origin)) return 'unavailable'
    const outcome = await canvas.place(items, {
      anchorObjectId: message.anchorObjectId,
      ...(placeholderIds.length ? { placeholderIds } : {}),
      isCurrent: () => current(origin),
    })
    if (outcome !== 'placed') canvas.discard(placeholderIds)
    return outcome
  }

  /**
   * 占位与产物交付不在同一条队列上：占位要在工具起跑那一刻就看得见，
   * 排在上一次交付（要下载图片字节）后面就白占了。交付侧 await 这个 promise 取回 id。
   */
  const reserve = (origin: DeliveryOrigin, messageId: string, request: AgentReservation) => {
    const canvas = origin.canvas
    // 事件按 id 幂等重放，续播会把同一条 toolStart 再喂一遍：占过的位不再占第二次。
    if (!canvas || origin.reserved.has(messageId) || !current(origin)) return
    origin.reserved.set(
      messageId,
      canvas.reserve({ ...request, messageId }).then(
        (ids) => {
          // 等画布恢复场景期间用户切走了：框已经建在那块画布上，就地收掉，别留成孤儿。
          if (current(origin)) return ids
          canvas.discard(ids)
          return []
        },
        (error) => {
          console.warn('[agent] canvas reservation failed', error)
          return []
        },
      ),
    )
  }

  const releaseAll = async (origin: DeliveryOrigin) => {
    const canvas = origin.canvas
    const pending = [...origin.reserved.values()]
    origin.reserved.clear()
    if (!canvas) return
    // 轮中止 / 失败时工具永远等不到 toolEnd，占的位不收就是一屏僵尸转圈。
    for (const ids of await Promise.all(pending)) canvas.discard(ids)
  }

  const enqueue = (
    origin: DeliveryOrigin,
    message: AgentToolMessage,
    manual = false,
    retry = false,
  ) => {
    const previous = records.get(message.id)
    if (previous && ((!manual && !retry) || previous.status === 'pending')) {
      if (belongs(origin)) changed(message.id, previous.status)
      origin.pending = previous.pending.then(() => {
        if (belongs(origin)) changed(message.id, previous.status)
      })
      return origin.pending
    }
    const record: DeliveryRecord = { status: 'pending', pending: Promise.resolve() }
    records.set(message.id, record)
    if (belongs(origin)) changed(message.id, 'pending')
    record.pending = queue = queue.then(async () => {
      try {
        record.status = await place(origin, message, manual)
      } catch (error) {
        console.warn('[agent] artifact delivery failed', error)
        record.status = 'failed'
      }
      if (belongs(origin)) changed(message.id, record.status)
    })
    origin.pending = record.pending
    return record.pending
  }

  return {
    /** 只恢复交付展示，不下载历史产物；文字与进行中的轮不等场景恢复。 */
    async restore(messages: readonly AgentPanelMessage[]) {
      const owner = generation
      const ownerScope = scope()
      let canvas = agentCanvasSink()
      try {
        if (canvas?.ready) await canvas.ready
      } catch (error) {
        console.warn('[agent] canvas restore failed', error)
        canvas = null
      }
      if (generation !== owner || scope() !== ownerScope) return
      const target = canvas === agentCanvasSink() ? canvas : null
      for (const message of messages) {
        if (
          message.kind !== 'tool' ||
          message.status !== 'succeeded' ||
          !message.artifacts?.length ||
          records.has(message.id)
        )
          continue
        changed(
          message.id,
          target && message.artifacts.every((artifact) => target.has(artifact.artifactId))
            ? 'placed'
            : 'unavailable',
        )
      }
    },
    beginTurn(): TurnArtifactDelivery {
      const origin = capture()
      return {
        isCurrent: () => belongs(origin),
        canContinue: () => belongs(origin) || current(origin),
        reserve(messageId: string, request: AgentReservation) {
          reserve(origin, messageId, request)
        },
        enqueue(message: AgentToolMessage) {
          if (message.artifacts?.length) void enqueue(origin, message)
        },
        failed(messageId: string, message: string | undefined) {
          const note = message ?? i18next.t('delivery.generateFailed', { ns: 'agent' })
          void claim(origin, messageId)?.then((ids) => origin.canvas?.markFailed(ids, note))
        },
        discard(messageId: string) {
          void claim(origin, messageId)?.then((ids) => origin.canvas?.discard(ids))
        },
        async settled() {
          await origin.pending
          await releaseAll(origin)
          origins.delete(origin)
        },
      }
    },
    async placeOnCanvas(message: AgentToolMessage) {
      const origin = capture()
      try {
        await enqueue(origin, message, true)
      } finally {
        origins.delete(origin)
      }
    },
    /**
     * 画布回来了：这个会话里因为画布不在（切去了别的模式、画布正在重挂）而没落下去的
     * 产物，现在补落。只补本会话交付过的那些——历史里被用户删掉的不在此列，那是他的决定。
     */
    async redeliverUnavailable(messages: readonly AgentPanelMessage[]) {
      for (const message of messages) {
        if (message.kind !== 'tool' || !message.artifacts?.length) continue
        if (records.get(message.id)?.status !== 'unavailable') continue
        const origin = capture()
        try {
          await enqueue(origin, message, false, true)
        } finally {
          origins.delete(origin)
        }
      }
    },
    reset() {
      generation += 1
      origins.clear()
      records.clear()
      queue = Promise.resolve()
      const owner = generation
      const ownerScope = scope()
      return () => generation === owner && scope() === ownerScope
    },
  }
}
