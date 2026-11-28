import * as Y from 'yjs'

/**
 * 上传中节点的本机文件 id：不能冒充云媒体（cloud- 前缀只配 mediaId），不能内嵌图片数据，
 * 也不能是原型链上的名字（__proto__、constructor、toString…）：客户端用普通对象 files[fileId]
 * 查本机图，这些名字会查到继承来的函数或对象而不是 undefined。
 */
export function isLocalCanvasFileId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    !value.startsWith('cloud-') &&
    !(value in Object.prototype) &&
    /^[\w.:-]+$/.test(value)
  )
}
/**
 * 上传中节点由哪台设备在传、从什么时候开始：放在 meta 里（旧编辑器来回同步也保留 meta）。
 * 别的设备据此只把「有人在传、还没过期」的节点显示成上传中；本机缺原图又不是别人在传的，仍按缺图处理。
 */
export const CANVAS_UPLOAD_DEVICE_META = 'uploadDevice'
export const CANVAS_UPLOAD_STARTED_META = 'uploadStartedAt'
/**
 * 上传失败停下时撤掉声明的时间。不只删掉声明，还记下撤销时间：并发合并时据此认出「撤掉声明」这次簿记，
 * 别的设备同时改节点时照抄来的旧声明（开始时间早于它）不会被当成新声明把它顶回去。
 */
export const CANVAS_UPLOAD_RELEASED_META = 'uploadReleasedAt'
/** 实际有效期与旧排序号分离；绑定节点实例、内容、设备和该次声明，旧页不能借复制元数据续期。 */
export const CANVAS_UPLOAD_LEASE_AT_META = 'uploadLeaseAt'
export const CANVAS_UPLOAD_LEASE_FOR_META = 'uploadLeaseFor'
/** 超过这么久还没收成云媒体，就不再显示「上传中」而显示缺图（上传那台设备可能已离线或失败）。 */
export const CANVAS_UPLOAD_STALE_MS = 30 * 60_000
/** 别的设备写的开始时间最多可以比本机时钟晚这么多（设备间的时钟偏差）。 */
export const CANVAS_UPLOAD_CLOCK_SKEW_MS = 5 * 60_000

export interface CanvasUploadData {
  fileId?: string
  mediaId?: string
  meta?: Record<string, string>
}

/** 这个节点是不是别的设备声明在传、而且还没过期的上传中图片。 */
export function canvasUploadingElsewhere(
  data: CanvasUploadData,
  device: string,
  now: number,
  nodeKey?: string,
): boolean {
  if (data.mediaId || !isLocalCanvasFileId(data.fileId)) return false
  const by = data.meta?.[CANVAS_UPLOAD_DEVICE_META]
  const since = canvasUploadClaimTime(data, nodeKey)
  // 开始时间不能比本机时钟晚太多：容忍设备间几分钟的时钟偏差，再往后的（时钟错乱或伪造）不算在传，
  // 否则这个节点会一直被当成上传中、绕过缺图处理。
  return (
    !!by &&
    by !== device &&
    Number.isFinite(since) &&
    since - now <= CANVAS_UPLOAD_CLOCK_SKEW_MS &&
    now - since < CANVAS_UPLOAD_STALE_MS
  )
}

/**
 * canvasUploadingElsewhere 的结果下一次会在什么时刻翻转（绝对毫秒时间），不会再变时返回 undefined。
 * 界面据此定一个时钟：别的设备不再续期时，到点从「上传中」换成缺图，而不必等别的改动触发重渲染。
 */
export function canvasUploadClaimNextChange(
  data: CanvasUploadData,
  device: string,
  now: number,
  nodeKey?: string,
): number | undefined {
  if (data.mediaId || !isLocalCanvasFileId(data.fileId)) return undefined
  const by = data.meta?.[CANVAS_UPLOAD_DEVICE_META]
  const since = canvasUploadClaimTime(data, nodeKey)
  if (!by || by === device || !Number.isFinite(since)) return undefined
  if (since - now > CANVAS_UPLOAD_CLOCK_SKEW_MS) return since - CANVAS_UPLOAD_CLOCK_SKEW_MS
  if (now - since < CANVAS_UPLOAD_STALE_MS) return since + CANVAS_UPLOAD_STALE_MS
  return undefined
}

/** 去掉上传声明和撤销记录（收成云媒体后）；都没有时原样返回。 */
export function withoutCanvasUploadClaim(
  meta: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (
    !meta ||
    !(
      CANVAS_UPLOAD_DEVICE_META in meta ||
      CANVAS_UPLOAD_STARTED_META in meta ||
      CANVAS_UPLOAD_RELEASED_META in meta ||
      CANVAS_UPLOAD_LEASE_AT_META in meta ||
      CANVAS_UPLOAD_LEASE_FOR_META in meta
    )
  )
    return meta
  const {
    [CANVAS_UPLOAD_DEVICE_META]: _device,
    [CANVAS_UPLOAD_STARTED_META]: _since,
    [CANVAS_UPLOAD_RELEASED_META]: _released,
    [CANVAS_UPLOAD_LEASE_AT_META]: _leaseAt,
    [CANVAS_UPLOAD_LEASE_FOR_META]: _leaseFor,
    ...rest
  } = meta
  return rest
}

const uploadTime = (value: string | undefined) => {
  const at = Number(value)
  return value !== undefined && Number.isSafeInteger(at) && at >= 0 && at < Number.MAX_SAFE_INTEGER
    ? at
    : Number.NEGATIVE_INFINITY
}
/** meta 上最近一次上传簿记（写声明或撤销声明）的时间；都没有时为负无穷。 */
export function canvasUploadBookkeepingTime(meta: Record<string, string> | undefined): number {
  const claimed = meta?.[CANVAS_UPLOAD_DEVICE_META]
    ? uploadTime(meta[CANVAS_UPLOAD_STARTED_META])
    : Number.NEGATIVE_INFINITY
  return Math.max(claimed, uploadTime(meta?.[CANVAS_UPLOAD_RELEASED_META]))
}
/**
 * 新一次簿记（声明或撤销）要写的时间：取本机时钟，但至少比节点上已有的簿记晚 1ms。
 * 设备间时钟有偏差时，本机时钟可能落后于别的设备写的旧声明；这样新簿记仍按写入先后排在后面，
 * 并发合并不会把它当成照抄来的旧值。
 */
export function nextCanvasUploadStamp(
  meta: Record<string, string> | undefined,
  now: number,
): number {
  const previous = canvasUploadBookkeepingTime(meta)
  return Number.isFinite(previous) ? Math.max(now, Math.floor(previous) + 1) : now
}

/** 节点在 Y.Doc 中的实例身份：删掉重建同 id 的节点也不能借用旧租约。 */
export function canvasUploadNodeKey(doc: Y.Doc, nodeId: string): string | undefined {
  const node = doc.getMap<Y.Map<unknown>>('nodes').get(nodeId)
  const id = node instanceof Y.Map ? node._item?.id : undefined
  return id && Number.isSafeInteger(id.client) && Number.isSafeInteger(id.clock)
    ? JSON.stringify([nodeId, id.client, id.clock])
    : undefined
}

function leaseBinding(data: CanvasUploadData, nodeKey: string | undefined): string | undefined {
  const by = data.meta?.[CANVAS_UPLOAD_DEVICE_META]
  const stamp = uploadTime(data.meta?.[CANVAS_UPLOAD_STARTED_META])
  if (!nodeKey || !by || !isLocalCanvasFileId(data.fileId) || !Number.isFinite(stamp))
    return undefined
  return JSON.stringify([
    nodeKey,
    data.fileId,
    data.meta?.contentIdentity ?? data.fileId,
    by,
    stamp,
  ])
}

/** 只读有效绑定的绝对租约；不按收到/重放的时间续期。 */
export function canvasUploadLeaseTime(
  data: CanvasUploadData,
  nodeKey: string | undefined,
): number | undefined {
  const binding = leaseBinding(data, nodeKey)
  const at = uploadTime(data.meta?.[CANVAS_UPLOAD_LEASE_AT_META])
  return binding !== undefined &&
    data.meta?.[CANVAS_UPLOAD_LEASE_FOR_META] === binding &&
    Number.isFinite(at)
    ? at
    : undefined
}

export function canvasUploadClaimTime(data: CanvasUploadData, nodeKey?: string): number {
  if (!data.meta?.[CANVAS_UPLOAD_DEVICE_META]) return Number.NEGATIVE_INFINITY
  if (
    data.meta[CANVAS_UPLOAD_LEASE_AT_META] !== undefined ||
    data.meta[CANVAS_UPLOAD_LEASE_FOR_META] !== undefined
  )
    return canvasUploadLeaseTime(data, nodeKey) ?? Number.NEGATIVE_INFINITY
  return uploadTime(data.meta[CANVAS_UPLOAD_STARTED_META])
}

/** 旧声明号继续单调增长供旧合并器排序，实际有效期使用独立、绑定的本次时钟时间。 */
export function claimCanvasUpload(
  data: CanvasUploadData,
  device: string,
  now: number,
  nodeKey: string | undefined,
): Record<string, string> {
  const meta = {
    ...withoutCanvasUploadClaim(data.meta),
    [CANVAS_UPLOAD_DEVICE_META]: device,
    [CANVAS_UPLOAD_STARTED_META]: String(nextCanvasUploadStamp(data.meta, now)),
  }
  const binding = leaseBinding({ ...data, meta }, nodeKey)
  return binding
    ? {
        ...meta,
        [CANVAS_UPLOAD_LEASE_AT_META]: String(now),
        [CANVAS_UPLOAD_LEASE_FOR_META]: binding,
      }
    : meta
}

/** 上传失败停下时撤掉声明：去掉声明，记下撤销时间（见 CANVAS_UPLOAD_RELEASED_META）。 */
export function releaseCanvasUploadClaim(
  meta: Record<string, string> | undefined,
  now: number,
): Record<string, string> {
  return {
    ...withoutCanvasUploadClaim(meta),
    [CANVAS_UPLOAD_RELEASED_META]: String(nextCanvasUploadStamp(meta, now)),
  }
}
