import * as Y from 'yjs'
import {
  CANVAS_UPLOAD_DEVICE_META,
  CANVAS_UPLOAD_STARTED_META,
  isLocalCanvasFileId,
  withoutCanvasUploadClaim,
} from './canvas-cloud'
import { type CanvasOrigin, updateCanvasNode } from './canvas-document'

interface UploadData {
  fileId?: string
  mediaId?: string
  meta?: Record<string, string>
  [key: string]: unknown
}

const isData = (value: unknown): value is UploadData =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** promoted 是不是把 base（本机格式 fileId、尚无 mediaId）收成云媒体的那一次写入。 */
function isPromotionOf(promoted: UploadData, base: UploadData): boolean {
  return (
    !!promoted.mediaId &&
    promoted.fileId === `cloud-${promoted.mediaId}` &&
    !base.mediaId &&
    isLocalCanvasFileId(base.fileId) &&
    promoted.meta?.contentIdentity === (base.meta?.contentIdentity ?? base.fileId)
  )
}

/**
 * claimed 是不是给 base 写上（或续上）上传声明的那一次写入。声明总是用写入时的时间，
 * 所以要比 base 的声明新；用户编辑只会照抄已有的（更旧的）声明，不会被当成簿记。
 */
function isClaimOf(claimed: UploadData, base: UploadData): boolean {
  const since = Number(claimed.meta?.[CANVAS_UPLOAD_STARTED_META])
  const before = base.meta?.[CANVAS_UPLOAD_DEVICE_META]
    ? Number(base.meta?.[CANVAS_UPLOAD_STARTED_META])
    : Number.NEGATIVE_INFINITY
  return (
    !!claimed.meta?.[CANVAS_UPLOAD_DEVICE_META] &&
    !claimed.mediaId &&
    !base.mediaId &&
    isLocalCanvasFileId(base.fileId) &&
    claimed.fileId === base.fileId &&
    Number.isFinite(since) &&
    since > (Number.isNaN(before) ? Number.NEGATIVE_INFINITY : before)
  )
}

/** 用户的改动（user）上叠上传簿记（book）：只取 fileId / mediaId / 上传声明 / contentIdentity。 */
function withBookkeeping(user: UploadData, book: UploadData): UploadData {
  if (book.mediaId)
    return {
      ...user,
      fileId: book.fileId,
      mediaId: book.mediaId,
      meta: {
        ...withoutCanvasUploadClaim(user.meta),
        ...(book.meta?.contentIdentity ? { contentIdentity: book.meta.contentIdentity } : {}),
      },
    }
  return {
    ...user,
    meta: {
      ...user.meta,
      [CANVAS_UPLOAD_DEVICE_META]: book.meta?.[CANVAS_UPLOAD_DEVICE_META] ?? '',
      [CANVAS_UPLOAD_STARTED_META]: book.meta?.[CANVAS_UPLOAD_STARTED_META] ?? '',
    },
  }
}

/**
 * 节点 data 在 Yjs 里是整块值，并发写只留一个。上传簿记（声明、收成云媒体）和用户编辑并发时，
 * 把输掉的一方补回赢的一方：簿记赢了就把用户改动叠回去，用户改动赢了就把簿记叠上去。
 * 两边都不是簿记（两个人同时改）时按 Yjs 原样取舍，返回 undefined；合并结果与 winner 相同也返回 undefined。
 */
export function mergeCanvasUploadConflict(lost: unknown, winner: unknown): UploadData | undefined {
  if (!isData(lost) || !isData(winner)) return undefined
  let merged: UploadData
  if (isPromotionOf(winner, lost) || isClaimOf(winner, lost)) merged = withBookkeeping(lost, winner)
  else if (isPromotionOf(lost, winner) || isClaimOf(lost, winner))
    merged = withBookkeeping(winner, lost)
  else return undefined
  return JSON.stringify(merged) === JSON.stringify(winner) ? undefined : merged
}

/**
 * 盯住远端更新：本机写的节点 data 被一次「没见过它」的远端写入顶掉时（并发，而不是先后），
 * 按 mergeCanvasUploadConflict 把两边合回去再写一次。只由输掉写入的那台设备补，别的设备不重复写。
 */
export function watchCanvasUploadConflicts(
  doc: Y.Doc,
  isRemote: (origin: unknown) => boolean,
  origin: CanvasOrigin,
): () => void {
  const nodes = doc.getMap<Y.Map<unknown>>('nodes')
  const observer = (events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction) => {
    if (!isRemote(transaction.origin)) return
    const repairs: { id: string; winner: unknown; data: UploadData }[] = []
    for (const event of events) {
      if (event.path.length !== 1 || !event.keys.has('data')) continue
      const node = event.target as Y.Map<unknown>
      const current = node._map.get('data')
      if (!current || current.deleted || !event.adds(current)) continue
      // 这次之前生效的那一版：往左跳过这次新加的条目，第一个旧条目就是它。
      let previous = current.left
      while (previous && event.adds(previous)) previous = previous.left
      if (!previous || previous.id.client !== doc.clientID || !event.deletes(previous)) continue
      // 这次新加的条目里有以它为起点写的，说明远端看过本机这一版，是先后改，不是并发。
      let seen = false
      for (let item: Y.Item | null = current; item && item !== previous; item = item.left)
        if (event.adds(item) && item.origin && Y.compareIDs(item.origin, previous.id)) seen = true
      if (seen) continue
      const lostContent = previous.content.getContent()
      const winnerContent = current.content.getContent()
      const lost = lostContent[lostContent.length - 1]
      const winner = winnerContent[winnerContent.length - 1]
      const data = mergeCanvasUploadConflict(lost, winner)
      if (data) repairs.push({ id: String(event.path[0]), winner, data })
    }
    if (!repairs.length) return
    // 观察者里不改文档：等这次事务收尾后再写，写之前确认节点还停在赢的那一版。
    queueMicrotask(() => {
      doc.transact(() => {
        for (const { id, winner, data } of repairs)
          if (nodes.get(id)?.get('data') === winner)
            updateCanvasNode(doc, id, { data: data as never }, origin)
      }, origin)
    })
  }
  nodes.observeDeep(observer)
  return () => nodes.unobserveDeep(observer)
}
