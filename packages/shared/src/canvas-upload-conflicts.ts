import * as Y from 'yjs'
import {
  CANVAS_UPLOAD_DEVICE_META,
  CANVAS_UPLOAD_RELEASED_META,
  CANVAS_UPLOAD_STARTED_META,
  canvasUploadBookkeepingTime,
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

const time = (value: string | undefined) => {
  const at = Number(value)
  return value !== undefined && Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY
}
/** data 上最近一次上传簿记（写声明或撤销声明）的时间；都没有时为负无穷。 */
const bookkeepingTime = (data: UploadData) => canvasUploadBookkeepingTime(data.meta)

/**
 * claimed 是不是给 base 写上（或续上）上传声明的那一次写入。声明的时间由 nextCanvasUploadStamp 取，
 * 总比 base 上的簿记（声明或撤销）新，设备间时钟有偏差也一样；用户编辑只会照抄已有的（更旧的）声明，不会被当成簿记。
 */
function isClaimOf(claimed: UploadData, base: UploadData): boolean {
  const since = time(claimed.meta?.[CANVAS_UPLOAD_STARTED_META])
  return (
    !!claimed.meta?.[CANVAS_UPLOAD_DEVICE_META] &&
    !claimed.mediaId &&
    !base.mediaId &&
    isLocalCanvasFileId(base.fileId) &&
    claimed.fileId === base.fileId &&
    Number.isFinite(since) &&
    since > bookkeepingTime(base)
  )
}

/**
 * released 是不是上传失败停下时撤掉声明的那一次写入：没有声明、带撤销时间，且比 base 上的簿记新。
 * 用户编辑照抄的是撤销之前的旧声明，时间更早，所以不会把撤销顶回去。
 */
function isReleaseOf(released: UploadData, base: UploadData): boolean {
  const at = time(released.meta?.[CANVAS_UPLOAD_RELEASED_META])
  return (
    !released.meta?.[CANVAS_UPLOAD_DEVICE_META] &&
    !released.mediaId &&
    !base.mediaId &&
    isLocalCanvasFileId(base.fileId) &&
    released.fileId === base.fileId &&
    Number.isFinite(at) &&
    at > bookkeepingTime(base)
  )
}

/** 用户的改动（user）上叠上传簿记（book）：只取 fileId / mediaId / 上传声明或撤销 / contentIdentity。 */
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
  if (!book.meta?.[CANVAS_UPLOAD_DEVICE_META])
    return {
      ...user,
      meta: {
        ...withoutCanvasUploadClaim(user.meta),
        [CANVAS_UPLOAD_RELEASED_META]: book.meta?.[CANVAS_UPLOAD_RELEASED_META] ?? '',
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
 * 节点 data 在 Yjs 里是整块值，并发写只留一个。上传簿记（声明、撤销声明、收成云媒体）和用户编辑并发时，
 * 把输掉的一方补回赢的一方：簿记赢了就把用户改动叠回去，用户改动赢了就把簿记叠上去。
 * 两边都不是簿记（两个人同时改）时按 Yjs 原样取舍，返回 undefined；合并结果与 winner 相同也返回 undefined。
 */
export function mergeCanvasUploadConflict(lost: unknown, winner: unknown): UploadData | undefined {
  if (!isData(lost) || !isData(winner)) return undefined
  let merged: UploadData
  if (bookkeeping(winner, lost)) merged = withBookkeeping(lost, winner)
  else if (bookkeeping(lost, winner)) merged = withBookkeeping(winner, lost)
  else return undefined
  return sameValue(merged, winner) ? undefined : merged
}

/** book 是在 user 这一版上做的上传簿记（收成云媒体、声明、撤销声明）。 */
function bookkeeping(book: UploadData, user: UploadData): boolean {
  return isPromotionOf(book, user) || isClaimOf(book, user) || isReleaseOf(book, user)
}

/** 与键顺序无关的深比较：merged 是展开后重写的对象，键顺序可能和 winner 不同。 */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((value, index) => sameValue(value, b[index]))
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left).filter((key) => left[key] !== undefined)
  const otherKeys = Object.keys(right).filter((key) => right[key] !== undefined)
  return (
    keys.length === otherKeys.length &&
    keys.every(
      (key) => Object.prototype.hasOwnProperty.call(right, key) && sameValue(left[key], right[key]),
    )
  )
}

/*
 * 判断「并发覆盖」要看 Y.Map 某个键背后的条目链（_map / Item.left / Item.origin / content），
 * Yjs 没有公开 API 能拿到被并发顶掉的那一版和它的因果关系。这些私有结构只在下面这一个函数里读，
 * 读之前逐个校验形状，形状不对（Yjs 升级改了内部结构）就用 console.error 报一次，再退回 Yjs 原生的取舍，
 * 不会抛错也不会误写；依赖里 yjs 锁在 ~13.6，升级小版本要先过契约测试；__tests__/canvas-upload-conflicts.test.ts 里的「Yjs 内部结构契约」用例
 * 会在升级后第一时间失败，提醒同步修改这里。
 */
interface ItemShape {
  id: Y.ID
  left: ItemShape | null
  origin: Y.ID | null
  deleted: boolean
  content: { getContent(): unknown[] }
}

function isItemShape(value: unknown): value is ItemShape {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<ItemShape>
  return (
    !!item.id &&
    typeof item.id.client === 'number' &&
    'left' in item &&
    'origin' in item &&
    typeof item.deleted === 'boolean' &&
    typeof item.content?.getContent === 'function'
  )
}

let reportedUnsupported = false
/**
 * 内部结构不认识时不能悄悄当成「没冲突」：那样被顶掉的 mediaId / 上传声明就再也补不回来，没人知道。
 * 这里大声报一次（前端的错误上报会收到），提醒按新版 Yjs 改这里；行为上仍退回 Yjs 原生取舍，不误写。
 */
function reportUnsupported(reason: string, error?: unknown) {
  if (reportedUnsupported) return
  reportedUnsupported = true
  console.error(
    `[canvas-upload-conflicts] Yjs 内部结构与预期不符（${reason}），并发覆盖的上传结果将无法自动补回`,
    error,
  )
}

function lastContent(item: ItemShape): unknown {
  const content = item.content.getContent()
  return content[content.length - 1]
}

/**
 * 从生效的一版往左列出 data 的全部历史条目，并找出其中「并发输掉的一版」：满足 isCandidate、已被删除，
 * 而且生效的一版和这次新加的条目（isNew）都没见过它（不在它们的 origin 链上）。见过的是先后改，不补。
 * 只列各条并发分支上最新的一版：同一分支上更早的条目被同分支后来的写入见过，自然排除。按从旧到新返回。
 */
function concurrentLosers(
  current: ItemShape,
  isNew: (item: ItemShape) => boolean,
  isCandidate: (item: ItemShape) => boolean,
): ItemShape[] | undefined {
  const chain: ItemShape[] = []
  for (let item: unknown = current; item; item = (item as ItemShape).left) {
    if (!isItemShape(item)) {
      reportUnsupported('Item')
      return undefined
    }
    chain.push(item)
  }
  const key = (id: { client: number; clock: number }) => `${id.client}:${id.clock}`
  const byId = new Map(chain.map((item) => [key(item.id), item]))
  const seen = new Set<ItemShape>()
  for (const item of chain) {
    if (item !== current && !isNew(item)) continue
    // 沿 origin 链往回走：写这一版时看到的上一版、再上一版……都被它见过。
    for (let origin = item.origin; origin; ) {
      const seenItem = byId.get(key(origin))
      if (!seenItem || seen.has(seenItem)) break
      seen.add(seenItem)
      origin = seenItem.origin
    }
  }
  return chain
    .filter((item) => item !== current && item.deleted && isCandidate(item) && !seen.has(item))
    .reverse()
}

/**
 * 生效的一版和几个并发输掉的版本（从旧到新）合并，都相对生效的那一版判断：
 * 生效的是簿记时，用户改动取输家里最新的一版、叠上生效的簿记；输家里的簿记都叠到结果上，
 * 收成云媒体最后叠（它盖过声明和撤销）。输家之间按 Yjs 原样取舍，不互相合。合不出变化时返回 undefined。
 */
export function mergeCanvasUploadConflicts(
  lost: unknown[],
  winner: unknown,
): UploadData | undefined {
  if (lost.length === 1) return mergeCanvasUploadConflict(lost[0], winner)
  if (!isData(winner)) return undefined
  const versions = lost.filter(isData)
  let merged = winner
  const user = [...versions].reverse().find((version) => bookkeeping(winner, version))
  if (user) merged = withBookkeeping(user, winner)
  const books = versions
    .filter((version) => bookkeeping(version, winner))
    .sort((a, b) => Number(!!a.mediaId) - Number(!!b.mediaId))
  for (const book of books) merged = withBookkeeping(merged, book)
  return sameValue(merged, winner) ? undefined : merged
}

/**
 * 这次远端事件里，节点 data 上有没有本机写入和远端写入并发（谁也没见过谁）：有的话返回输掉的各版
 * （从旧到新）和现在生效的那一版，否则（先后改、两边都不是本机、内部结构不认识）返回 undefined。两种取舍都认：
 * 远端赢、本机这一版被顶掉；本机赢、远端这次写入一进来就是被删掉的（远端的几次并发写入都算，不止最近一次）。
 * 后一种不能指望远端那台设备来补：它可能已经离线（比如重新打开时才合并的离线改动），所以本机也补；
 * 两边都补时写的是同一份合并结果，会收敛。
 */
export function readOverwrittenLocalData(
  event: Y.YEvent<Y.AbstractType<unknown>>,
  local: number | ((client: number) => boolean),
): { lost: unknown[]; winner: unknown } | undefined {
  try {
    const isLocal = typeof local === 'number' ? (client: number) => client === local : local
    const map = (event.target as unknown as { _map?: unknown })._map
    if (!(map instanceof Map)) {
      reportUnsupported('Y.Map._map')
      return undefined
    }
    const current: unknown = map.get('data')
    if (current === undefined) return undefined
    if (!isItemShape(current)) {
      reportUnsupported('Item')
      return undefined
    }
    if (current.deleted) return undefined
    const adds = (item: ItemShape) => event.adds(item as never)
    const localWins = !adds(current)
    // 本机这一版还生效：看这次新加、却一进来就被删掉的远端条目。
    // 远端这次写入生效：看这次被删掉的本机条目。
    if (localWins && !isLocal(current.id.client)) return undefined
    const losers = concurrentLosers(current, adds, (item) =>
      localWins
        ? adds(item) && !isLocal(item.id.client)
        : event.deletes(item as never) && isLocal(item.id.client),
    )
    if (!losers?.length) return undefined
    return { lost: losers.map(lastContent), winner: lastContent(current) }
  } catch (error) {
    reportUnsupported('读取时出错', error)
    return undefined
  }
}

/**
 * 重新打开时从本机 IndexedDB 一次性回放的历史里，节点 data 有没有并发写入（谁也没见过谁）：
 * 比如两个标签页离线时各写了一次，都是本机写的，回放前也都不在内存里。返回输掉的各版和生效的那一版。
 * 回放从空文档开始时节点本身也是这次新加的，Yjs 不为它发事件，所以按事务（回放结束、回收删除内容之前）读：
 * 输掉的条目在这次回放里加进来又被删掉、生效的一版和其后的写入都没见过它，就是并发；见过就是先后改。
 */
export function readReplayedOverwrite(
  node: Y.Map<unknown>,
  transaction: Y.Transaction,
): { lost: unknown[]; winner: unknown } | undefined {
  try {
    const added = (item: ItemShape) =>
      item.id.clock >= (transaction.beforeState.get(item.id.client) ?? 0)
    const map = (node as unknown as { _map?: unknown })._map
    if (!(map instanceof Map)) {
      reportUnsupported('Y.Map._map')
      return undefined
    }
    const current: unknown = map.get('data')
    if (current === undefined) return undefined
    if (!isItemShape(current)) {
      reportUnsupported('Item')
      return undefined
    }
    if (current.deleted || !added(current)) return undefined
    const losers = concurrentLosers(current, added, added)
    if (!losers?.length) return undefined
    return { lost: losers.map(lastContent), winner: lastContent(current) }
  } catch (error) {
    reportUnsupported('读取时出错', error)
    return undefined
  }
}

let selfCheck: boolean | undefined

/**
 * 运行时自检：用两份小文档实际造一次并发覆盖（远端赢、本机赢、本机存储回放各一次），确认按 Yjs 内部结构
 * 读得出输掉的一版。readOverwrittenLocalData 依赖 Y.Map._map 与 Item 的 left/origin/content 等未公开结构；
 * 装上的 yjs 内部变了（升级、重复安装）时这里返回 false，调用方要据此不走依赖补写的流程（例如不在图片
 * 上传完之前同步文档），而不是静默继续、让上传声明或 mediaId 被并发写入顶掉后补不回来。结果只算一次。
 */
export function canvasUploadConflictsSupported(): boolean {
  selfCheck ??= runSelfCheck()
  return selfCheck
}

function runSelfCheck(): boolean {
  try {
    const value = (data: unknown) => (isData(data) ? data.v : undefined)
    const seed = new Y.Doc()
    seed.clientID = 1
    seed.transact(() => {
      const node = new Y.Map<unknown>()
      node.set('data', { v: 'base' })
      seed.getMap<Y.Map<unknown>>('nodes').set('n', node)
    })
    const base = Y.encodeStateAsUpdate(seed)
    const writer = (clientID: number, v: string) => {
      const doc = new Y.Doc()
      doc.clientID = clientID
      Y.applyUpdate(doc, base)
      doc.getMap<Y.Map<unknown>>('nodes').get('n')?.set('data', { v })
      return doc
    }
    // 同一 key 并发写入时 clientID 大的一边生效。
    const live = (localId: number, remoteId: number) => {
      const local = writer(localId, 'local')
      const remote = writer(remoteId, 'remote')
      let found: { lost: unknown[]; winner: unknown } | undefined
      local.getMap('nodes').observeDeep((events) => {
        for (const event of events)
          if (event.path.length === 1) found ??= readOverwrittenLocalData(event, localId)
      })
      Y.applyUpdate(local, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(local)))
      return found
    }
    const remoteWins = live(2, 3)
    const localWins = live(3, 2)
    const replay = new Y.Doc()
    replay.clientID = 9
    let replayed: { lost: unknown[]; winner: unknown } | undefined
    replay.on('afterTransaction', (transaction: Y.Transaction) => {
      const node = replay.getMap<Y.Map<unknown>>('nodes').get('n')
      if (node instanceof Y.Map) replayed ??= readReplayedOverwrite(node, transaction)
    })
    replay.transact(() => {
      Y.applyUpdate(replay, Y.encodeStateAsUpdate(writer(2, 'remote')))
      Y.applyUpdate(replay, Y.encodeStateAsUpdate(writer(3, 'local')))
    })
    return (
      remoteWins?.lost.length === 1 &&
      value(remoteWins.lost[0]) === 'local' &&
      value(remoteWins.winner) === 'remote' &&
      localWins?.lost.length === 1 &&
      value(localWins.lost[0]) === 'remote' &&
      value(localWins.winner) === 'local' &&
      replayed?.lost.length === 1 &&
      value(replayed.lost[0]) === 'remote' &&
      value(replayed.winner) === 'local'
    )
  } catch (error) {
    reportUnsupported('自检时出错', error)
    return false
  }
}

/**
 * 盯住远端更新：本机写的节点 data 被一次「没见过它」的远端写入顶掉时（并发，而不是先后），
 * 按 mergeCanvasUploadConflict 把两边合回去再写一次。只由输掉写入的那台设备补，别的设备不重复写。
 * 返回的函数取消监听，并让已排队、还没执行的补写失效；持有文档的一方销毁前必须调用。
 * 本机写入来自重新打开前的会话时，clientID 已经换过；isLocalClient 用来认出本机以前用过的 clientID，
 * 默认只认当前的 doc.clientID。要在套用服务端初始状态之前注册，初次合并里的并发覆盖才能被补回。
 * isReplay 认出从本机存储回放历史的事务（例如 IndexedDB 加载）：回放里两次写入可能都是本机写的，
 * 按 readReplayedOverwrite 找并发覆盖。要在回放开始之前注册。
 */
export function watchCanvasUploadConflicts(
  doc: Y.Doc,
  isRemote: (origin: unknown) => boolean,
  origin: CanvasOrigin,
  isLocalClient: (client: number) => boolean = (client) => client === doc.clientID,
  isReplay: (origin: unknown) => boolean = () => false,
): () => void {
  const nodes = doc.getMap<Y.Map<unknown>>('nodes')
  type Repair = { id: string; lost: unknown[]; winner: unknown; data: UploadData }
  let stopped = false
  const observer = (events: Y.YEvent<Y.AbstractType<unknown>>[], transaction: Y.Transaction) => {
    if (isReplay(transaction.origin) || !isRemote(transaction.origin)) return
    const repairs: Repair[] = []
    for (const event of events) {
      // 不看 event.keys：本机赢时远端写入一进来就被删，data 的值没变，keys 里没有它，但事件照样触发。
      if (event.path.length !== 1) continue
      const overwritten = readOverwrittenLocalData(event, isLocalClient)
      if (!overwritten) continue
      const { lost, winner } = overwritten
      const data = mergeCanvasUploadConflicts(lost, winner)
      if (data) repairs.push({ id: String(event.path[0]), lost, winner, data })
    }
    repair(repairs)
  }
  const replayed = (transaction: Y.Transaction) => {
    if (!isReplay(transaction.origin)) return
    const repairs: Repair[] = []
    nodes.forEach((node, id) => {
      if (!(node instanceof Y.Map)) return
      const overwritten = readReplayedOverwrite(node, transaction)
      if (!overwritten) return
      const { lost, winner } = overwritten
      const data = mergeCanvasUploadConflicts(lost, winner)
      if (data) repairs.push({ id, lost, winner, data })
    })
    repair(repairs)
  }
  const repair = (repairs: Repair[]) => {
    if (!repairs.length) return
    // 观察者里不改文档：等这次事务收尾后再写，写之前确认节点还停在赢的那一版。
    queueMicrotask(() => {
      if (stopped) return
      doc.transact(() => {
        for (const { id, lost, winner, data } of repairs) {
          const now = nodes.get(id)?.get('data')
          if (now === undefined) continue
          // 排队期间同一调用栈里又进来别的远端写入、节点已不是赢的那一版：输掉的那一版谁都没合进去过，
          // 按现在这一版重新合；合不出来（比如上传已经收尾）就不写。
          const next = now === winner ? data : mergeCanvasUploadConflicts(lost, now)
          if (next) updateCanvasNode(doc, id, { data: next as never }, origin)
        }
      }, origin)
    })
  }
  nodes.observeDeep(observer)
  doc.on('afterTransaction', replayed)
  return () => {
    // 停掉之后连已经排队的补写也作废：会话销毁时文档可能正在 destroy。
    stopped = true
    nodes.unobserveDeep(observer)
    doc.off('afterTransaction', replayed)
  }
}
