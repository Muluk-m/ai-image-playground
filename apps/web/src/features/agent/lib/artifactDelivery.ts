import {
  type AgentCanvasEdit,
  type AgentToolArtifact,
  type AgentToolErrorCode,
  isVideoGenerationRecord,
} from '@image-playground/shared'
import { i18next } from '../../../i18n'
import { AGENT_CONVERSATION_KEY, scopedStorageName } from '../../../lib/authScope'
import { resolveMediaSource } from '../../../lib/cloudMedia'
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
  failed(messageId: string, message: string | undefined, errorCode?: AgentToolErrorCode): void
  /** 工具跑完了但没有产物：占的位直接收掉。 */
  discard(messageId: string): void
  /**
   * 后台任务：这次调用占的位不随本轮收掉，移交给返回的把手。任务结束时由它落图或标错；
   * 它与本轮同属一个画布与会话，切走之后同样按「画布已离开」处理。
   */
  handOff(messageId: string): TurnArtifactDelivery
  /** 单张重试：结果落回这些已经在画布上的失败占位，而不是另占新位。 */
  adopt(messageId: string, placeholderIds: readonly string[]): void
  settled(): Promise<void>
}

/** 一个会话的产物交付：每一轮、每一个后台任务都从它这里领一个把手。 */
export interface AgentArtifactDelivery {
  /** 只恢复交付展示，不下载历史产物；文字与进行中的轮不等场景恢复。 */
  restore(messages: readonly AgentPanelMessage[]): Promise<void>
  beginTurn(): TurnArtifactDelivery
  /** 产物没能落下去时由用户点「放入画布」：按当时的画布再落一次。 */
  placeOnCanvas(message: AgentToolMessage): Promise<void>
  /**
   * 画布回来了：这个会话里因为画布不在（切去了别的模式、画布正在重挂）而没落下去的
   * 产物，现在补落。只补本会话交付过的那些——历史里被用户删掉的不在此列，那是他的决定。
   */
  redeliverUnavailable(messages: readonly AgentPanelMessage[]): Promise<void>
  /** 交付换代：上一代的把手全部作废，返回的判定说这一代还是不是当前这一代。 */
  reset(): () => boolean
}

/**
 * 产物到画布对象：视频落的是封面加播放来源（mp4 不下载到本地）和它实际的生成参数。
 * 参数是服务端写的，但结果块会原样存进会话历史；形状不对就不带，片子照样能播。
 */
export function placedArtifact(artifact: AgentToolArtifact, dataUrl: string): AgentPlacedArtifact {
  const { artifactId, taskId, outputIndex } = artifact
  if (artifact.media !== 'video') return { artifactId, dataUrl }
  const generation = isVideoGenerationRecord(artifact.video) ? artifact.video : undefined
  return {
    artifactId,
    dataUrl,
    video: { taskId, outputIndex, ...(generation ? { generation } : {}) },
  }
}

async function prepare(artifact: AgentToolArtifact): Promise<AgentPlacedArtifact> {
  return placedArtifact(artifact, await artifactBitmap(artifact))
}

/**
 * 取回来的那张网图在画布上的对象 id。
 *
 * 不能直接用媒体 id：同一个地址取两次是同一张媒体，而画布对象 id 必须只属于这一次调用，
 * 否则第二次取图会被当成「已经在画布上」而整张丢掉。按调用编号就没有这个问题，重放同一条
 * 结果卡也仍然算出同一个 id，不会落第二遍。
 */
export function fetchedCanvasId(toolCallId: string, index: number): string {
  return `fetched_${toolCallId}_${index}`
}

/** 这张卡有东西要落画布：产物、取回来的网图、一条排好的时间线，或者一批对已有对象的改动。 */
export function deliverable(message: AgentToolMessage): boolean {
  return Boolean(
    message.artifacts?.length ||
      message.fetchedImages?.length ||
      message.timeline ||
      message.canvasEdit,
  )
}

/** 落完之后镜头要带去的画布对象。 */
function deliveredIds(message: AgentToolMessage): string[] {
  if (message.timeline) return [message.timeline.timelineId]
  // 改属性不产新对象，镜头带去被改的那几个。
  if (message.canvasEdit)
    return message.canvasEdit.edits.map((one: AgentCanvasEdit) => one.elementId)
  if (message.fetchedImages?.length)
    return message.fetchedImages.map((_, index) => fetchedCanvasId(message.toolCallId, index))
  return (message.artifacts ?? []).map((artifact) => artifact.artifactId)
}

/** 交付串行，文字流不等它；每轮持有原画布，持久化文档可在切换后完成交付。 */
export function createArtifactDelivery(
  changed: (messageId: string, status: AgentDeliveryStatus) => void,
): AgentArtifactDelivery {
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
    // 排时间线不产新媒体，只在画布上把已有的视频排成一条。
    if (message.timeline) {
      if (!canvas.placeTimeline) return 'unavailable'
      const outcome = await canvas.placeTimeline(message.timeline)
      return current(origin) ? outcome : 'unavailable'
    }
    // 改画布对象同样不产新媒体，只是给已有的打补丁。
    if (message.canvasEdit) {
      if (!canvas.editElements) return 'unavailable'
      const outcome = await canvas.editElements(message.canvasEdit)
      return current(origin) ? outcome : 'unavailable'
    }
    // 取回来的网图不经队列产物那条路：字节已经在这个人的媒体里，按 id 取回来直接落画布。
    // 也不问 `syncArtifacts`——服务端那条只认生成任务的产出，这张图不属于任何任务。
    if (message.fetchedImages?.length) {
      const items = message.fetchedImages.map((image, index) => ({
        image,
        artifactId: fetchedCanvasId(message.toolCallId, index),
      }))
      // 重放同一条结果卡（续播、切回画布）不落第二遍：id 是算出来的，已经在画布上就认得出。
      const missing = items.filter((one) => !canvas.has(one.artifactId))
      if (!missing.length) return 'placed'
      const placing = await Promise.all(
        missing.map(async ({ image, artifactId }) => ({
          artifactId,
          dataUrl: await resolveMediaSource(`aip-media:${image.imageId}`, 'original', true),
          name: image.name || i18next.t('fetchedImage.canvasName', { ns: 'agent' }),
        })),
      )
      if (!current(origin)) return 'unavailable'
      return await canvas.place(placing, {
        anchorObjectId: message.anchorObjectId,
        isCurrent: () => current(origin),
      })
    }
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
        ...(message.prompt ? { prompt: message.prompt } : {}),
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
        // 新结果不仅要落盘，还要进入当前视口；后台项目与重复事件不能抢走用户镜头。
        if (record.status === 'placed' && belongs(origin) && origin.canvas === agentCanvasSink()) {
          origin.canvas?.focus(deliveredIds(message))
        }
      } catch (error) {
        console.warn('[agent] artifact delivery failed', error)
        record.status = 'failed'
      }
      if (belongs(origin)) changed(message.id, record.status)
    })
    origin.pending = record.pending
    return record.pending
  }

  /** 一轮（或一个后台任务）的交付把手：占位、落图、标错都记在它自己的来源上。 */
  const handle = (origin: DeliveryOrigin): TurnArtifactDelivery => ({
    isCurrent: () => belongs(origin),
    canContinue: () => belongs(origin) || current(origin),
    reserve(messageId: string, request: AgentReservation) {
      reserve(origin, messageId, request)
    },
    enqueue(message: AgentToolMessage) {
      if (deliverable(message)) void enqueue(origin, message)
    },
    failed(messageId: string, message: string | undefined, errorCode?: AgentToolErrorCode) {
      const note = message ?? i18next.t('delivery.generateFailed', { ns: 'agent' })
      void claim(origin, messageId)?.then((ids) => origin.canvas?.markFailed(ids, note, errorCode))
    },
    discard(messageId: string) {
      void claim(origin, messageId)?.then((ids) => origin.canvas?.discard(ids))
    },
    handOff(messageId: string) {
      // 同一块画布、同一代会话：切走之后它与本轮一样落不下去，由结果卡手动放入兜底。
      const job: DeliveryOrigin = {
        generation: origin.generation,
        scope: origin.scope,
        canvas: origin.canvas,
        pending: Promise.resolve(),
        reserved: new Map(),
      }
      const reserved = claim(origin, messageId)
      if (reserved) job.reserved.set(messageId, reserved)
      origins.add(job)
      return handle(job)
    },
    adopt(messageId: string, placeholderIds: readonly string[]) {
      if (!origin.reserved.has(messageId))
        origin.reserved.set(messageId, Promise.resolve(placeholderIds))
    },
    async settled() {
      await origin.pending
      await releaseAll(origin)
      origins.delete(origin)
    },
  })

  return {
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
          !(message.artifacts?.length || message.fetchedImages?.length) ||
          records.has(message.id)
        )
          continue
        const placed = deliveredIds(message)
        changed(
          message.id,
          target && placed.every((objectId) => target.has(objectId)) ? 'placed' : 'unavailable',
        )
      }
    },
    beginTurn(): TurnArtifactDelivery {
      return handle(capture())
    },
    async placeOnCanvas(message: AgentToolMessage) {
      const origin = capture()
      try {
        await enqueue(origin, message, true)
      } finally {
        origins.delete(origin)
      }
    },
    async redeliverUnavailable(messages: readonly AgentPanelMessage[]) {
      for (const message of messages) {
        if (message.kind !== 'tool' || !deliverable(message)) continue
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
