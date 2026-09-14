import type { AgentToolArtifact } from '@image-playground/shared'
import { AGENT_CONVERSATION_KEY, scopedStorageName } from '../../../lib/authScope'
import type { AgentDeliveryStatus, AgentPanelMessage, AgentToolMessage } from '../types'
import { fetchToolImage, toolArtifactUrl } from './agentClient'
import { type AgentCanvasSink, type AgentPlacedArtifact, agentCanvasSink } from './canvasSink'
import { videoPosterDataUrl } from './videoPoster'

interface DeliveryOrigin {
  readonly generation: number
  readonly scope: string
  readonly canvas: AgentCanvasSink | null
  baseRevision: number | undefined
  pending: Promise<void>
}

interface DeliveryRecord {
  status: AgentDeliveryStatus
  pending: Promise<void>
}

export interface TurnArtifactDelivery {
  isCurrent(): boolean
  enqueue(message: AgentToolMessage): void
  settled(): Promise<void>
}

async function prepare(artifact: AgentToolArtifact): Promise<AgentPlacedArtifact> {
  const { artifactId, taskId, outputIndex } = artifact
  return artifact.media === 'video'
    ? {
        artifactId,
        dataUrl: await videoPosterDataUrl(toolArtifactUrl(artifact), artifact),
        video: { taskId, outputIndex },
      }
    : { artifactId, dataUrl: await fetchToolImage(artifact) }
}

/** 交付串行，文字流不等它；每轮独立持有原画布和基线，切会话使旧交付失效。 */
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
    belongs(origin) && origin.canvas !== null && agentCanvasSink() === origin.canvas

  const capture = (): DeliveryOrigin => {
    const canvas = agentCanvasSink()
    const origin = {
      generation,
      scope: scope(),
      canvas,
      baseRevision: canvas?.revision(),
      pending: Promise.resolve(),
    }
    origins.add(origin)
    return origin
  }

  const place = async (
    origin: DeliveryOrigin,
    message: AgentToolMessage,
    manual: boolean,
  ): Promise<AgentDeliveryStatus> => {
    const canvas = origin.canvas
    if (!canvas || !current(origin)) return 'unavailable'
    const missing = (message.artifacts ?? []).filter((artifact) => !canvas.has(artifact.artifactId))
    if (!missing.length) return 'placed'
    if (!manual && canvas.revision() !== origin.baseRevision) return 'conflict'
    const items = await Promise.all(missing.map(prepare))
    if (!current(origin)) return 'unavailable'
    const before = canvas.revision()
    const outcome = await canvas.place(items, {
      anchorObjectId: message.anchorObjectId,
      ...(!manual ? { baseRevision: origin.baseRevision } : {}),
      isCurrent: () => current(origin),
    })
    if (outcome === 'placed' && !manual) {
      // 同一画布上仍在交付的轮都认得这次智能体写入；用户修改过的基线不能被洗掉。
      for (const other of origins) {
        if (other.canvas === canvas && other.baseRevision === before && belongs(other))
          other.baseRevision = canvas.revision()
      }
    }
    return outcome
  }

  const enqueue = (origin: DeliveryOrigin, message: AgentToolMessage, manual = false) => {
    const previous = records.get(message.id)
    if (previous && (!manual || previous.status === 'pending')) {
      if (belongs(origin)) changed(message.id, previous.status)
      origin.pending = previous.pending
      return previous.pending
    }
    const record: DeliveryRecord = { status: 'pending', pending: Promise.resolve() }
    records.set(message.id, record)
    if (belongs(origin)) changed(message.id, 'pending')
    record.pending = queue = queue.then(async () => {
      try {
        record.status = await place(origin, message, manual)
      } catch (error) {
        console.warn('[agent] 产物交付失败', error)
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
        console.warn('[agent] 画布恢复失败', error)
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
        enqueue(message: AgentToolMessage) {
          if (message.artifacts?.length) void enqueue(origin, message)
        },
        async settled() {
          await origin.pending
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
