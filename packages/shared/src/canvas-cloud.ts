import * as Y from 'yjs'
import { type CanvasNode, readCanvasDocument } from './canvas-document'
import { canvasConnectionAllowed, canvasNodeKind } from './canvas-registry'
import { isCanvasStoryboardData } from './canvas-storyboard'
import { CANVAS_STATE_MAX_BYTES } from './canvas-sync'
import { isCanvasTextDelta } from './canvas-text'
import { restoreCanvasUndoLineage } from './canvas-undo-lineage'
import {
  isProjectDocument,
  isProjectTimelineClip,
  type ProjectDocument,
  type ProjectElement,
} from './project-protocol'
import { isVideoGenerationRecord } from './video-generation'

/** Read model for old consumers (Agent archive and project listing). Y.Doc is authoritative. */
export function canvasProjectDocument(doc: Y.Doc, identity: ProjectDocument): ProjectDocument {
  const { nodes, annotations } = readCanvasDocument(doc)
  const elements: ProjectElement[] = []
  for (const node of [...nodes, ...annotations].sort((a, b) => a.z - b.z)) {
    if ('points' in node) {
      const { z: _z, ...annotation } = node
      elements.push(annotation as ProjectElement)
      continue
    }
    const { id, x, y, width, height, type, data } = node
    const box = { id, x, y, width, height }
    if (type === 'text') {
      const { text, fontSize, fill } = data as Extract<CanvasNode, { type: 'text' }>['data']
      elements.push({ ...box, type, text, fontSize, fill })
    } else if (type === 'storyboard') {
      elements.push({ ...box, type, ...data } as ProjectElement)
    } else if (type === 'timeline') {
      elements.push({
        ...box,
        type,
        clips: (data as Extract<CanvasNode, { type: 'timeline' }>['data']).clips,
      })
    } else if ('mediaId' in data && data.mediaId) {
      const { fileId: _fileId, pending: _pending, ...image } = data
      elements.push({
        ...image,
        ...box,
        type: 'image',
        mediaId: data.mediaId,
        rotation: data.rotation ?? 0,
      })
    } else if ('pending' in data && data.pending?.type === 'generation') {
      elements.push({ ...box, ...data.pending })
    }
  }
  return { ...identity, elements }
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256
const isMediaId = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
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
/** 超过这么久还没收成云媒体，就不再显示「上传中」而显示缺图（上传那台设备可能已离线或失败）。 */
export const CANVAS_UPLOAD_STALE_MS = 30 * 60_000
/** 别的设备写的开始时间最多可以比本机时钟晚这么多（设备间的时钟偏差）。 */
export const CANVAS_UPLOAD_CLOCK_SKEW_MS = 5 * 60_000

interface CanvasUploadData {
  fileId?: string
  mediaId?: string
  meta?: Record<string, string>
}

/** 这个节点是不是别的设备声明在传、而且还没过期的上传中图片。 */
export function canvasUploadingElsewhere(
  data: CanvasUploadData,
  device: string,
  now: number,
): boolean {
  if (data.mediaId || !isLocalCanvasFileId(data.fileId)) return false
  const by = data.meta?.[CANVAS_UPLOAD_DEVICE_META]
  const since = Number(data.meta?.[CANVAS_UPLOAD_STARTED_META])
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
): number | undefined {
  if (data.mediaId || !isLocalCanvasFileId(data.fileId)) return undefined
  const by = data.meta?.[CANVAS_UPLOAD_DEVICE_META]
  const since = Number(data.meta?.[CANVAS_UPLOAD_STARTED_META])
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
      CANVAS_UPLOAD_RELEASED_META in meta
    )
  )
    return meta
  const {
    [CANVAS_UPLOAD_DEVICE_META]: _device,
    [CANVAS_UPLOAD_STARTED_META]: _since,
    [CANVAS_UPLOAD_RELEASED_META]: _released,
    ...rest
  } = meta
  return rest
}

const uploadTime = (value: string | undefined) => {
  const at = Number(value)
  return value !== undefined && Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY
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
const finite = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10_000_000
const allowed = (value: object, fields: string[]) =>
  Object.keys(value).every((key) => fields.includes(key))

/** Validate the complete candidate before accepting any update; never apply untrusted bytes to a live room. */
export function validateCloudCanvas(
  doc: Y.Doc,
  identity: ProjectDocument,
  legacyConnections: Record<string, string> = {},
): void {
  const roots = [
    'nodes',
    'edges',
    'annotations',
    'meta',
    'managedNodes',
    'deletedNodes',
    'legacyConnections',
    'groups',
    'groupMembers',
    'nodeResults',
    'mainResults',
    'nodeJobs',
    'timelineSlots',
    'undoLineage',
  ]
  if ([...doc.share.keys()].some((key) => !roots.includes(key)))
    throw new Error('invalid_canvas_document')
  // An update missing its causal predecessor cannot be validated yet. Clients resend a full diff on reconnect.
  if (doc.store.pendingStructs || doc.store.pendingDs) throw new Error('incomplete_canvas_update')
  if (Y.encodeStateAsUpdate(doc).length > CANVAS_STATE_MAX_BYTES)
    throw new Error('canvas_document_too_large')
  restoreCanvasUndoLineage(doc)
  for (const [key, value] of doc.getMap('nodes')) {
    if (!(value instanceof Y.Map) || value.get('id') !== key) throw new Error('invalid_canvas_node')
    if (JSON.stringify(value.get('data')).includes('data:image/'))
      throw new Error('invalid_canvas_node')
    if (value.get('type') === 'timeline') {
      const raw = value.toJSON()
      if (
        !object(raw.data) ||
        !isProjectDocument({
          version: 1,
          elements: [
            {
              id: key,
              type: 'timeline',
              x: raw.x,
              y: raw.y,
              width: raw.width,
              height: raw.height,
              clips: raw.data.clips,
            },
          ],
        })
      )
        throw new Error('invalid_canvas_timeline')
    }
    if (value.get('type') === 'storyboard') {
      const shots = value.get('storyboardShots')
      if (
        !isCanvasStoryboardData(value.get('data')) ||
        !(shots instanceof Y.Map) ||
        shots.size > 1000
      )
        throw new Error('invalid_canvas_storyboard')
      for (const [key, entry] of shots) {
        if (!(entry instanceof Y.Map)) throw new Error('invalid_canvas_storyboard')
        const { order, deleted, ...shot } = entry.toJSON()
        if (
          shot.id !== key ||
          !Number.isSafeInteger(order) ||
          Number(order) < 0 ||
          Number(order) > 1000 ||
          (deleted !== undefined && deleted !== true) ||
          !isCanvasStoryboardData({ shots: [shot] })
        )
          throw new Error('invalid_canvas_storyboard')
      }
    } else if (value.has('storyboardShots')) throw new Error('invalid_canvas_storyboard')
    if (value.has('richText')) {
      const text = value.get('richText')
      if (
        value.get('type') !== 'text' ||
        !(text instanceof Y.Text) ||
        text.length > 100000 ||
        !isCanvasTextDelta(text.toDelta())
      )
        throw new Error('invalid_canvas_text')
    }
  }
  for (const root of ['annotations', 'edges'])
    for (const [key, value] of doc.getMap(root))
      if (!object(value) || value.id !== key) throw new Error('invalid_canvas_document')
  const slots = doc.getMap('timelineSlots')
  if (slots.size > 12000) throw new Error('canvas_document_too_large')
  for (const [key, value] of slots) {
    let parts: unknown
    try {
      parts = JSON.parse(key)
    } catch {
      throw new Error('invalid_canvas_timeline')
    }
    if (
      !Array.isArray(parts) ||
      parts.length !== 4 ||
      !id(parts[0]) ||
      !(
        (parts[1] === 'source' && id(parts[2])) ||
        (parts[1] === 'legacy' &&
          Number.isSafeInteger(parts[2]) &&
          parts[2] >= 0 &&
          parts[2] < 1000)
      )
    )
      throw new Error('invalid_canvas_timeline')
    const field = parts[3]
    if (field === 'clip') {
      if (
        !isProjectTimelineClip(value) ||
        (parts[1] === 'source' && (!object(value) || value.elementId !== parts[2]))
      )
        throw new Error('invalid_canvas_timeline')
    } else if (field === 'order') {
      if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 1000)
        throw new Error('invalid_canvas_timeline')
    } else if (field === 'deleted') {
      if (typeof value !== 'boolean') throw new Error('invalid_canvas_timeline')
    } else throw new Error('invalid_canvas_timeline')
  }
  const { nodes, edges, annotations } = readCanvasDocument(doc)
  if (nodes.length + annotations.length > 1000 || edges.length > 4000)
    throw new Error('canvas_document_too_large')
  for (const annotation of annotations) {
    if (
      !allowed(annotation, ['id', 'type', 'points', 'stroke', 'strokeWidth', 'z']) ||
      !['arrow', 'freedraw'].includes(annotation.type) ||
      !finite(annotation.z) ||
      !isProjectDocument({ version: 1, elements: [(({ z: _z, ...value }) => value)(annotation)] })
    )
      throw new Error('invalid_canvas_annotation')
  }
  for (const node of nodes) {
    if (
      !object(node) ||
      !id(node.id) ||
      !allowed(node, ['id', 'type', 'x', 'y', 'width', 'height', 'z', 'data']) ||
      !['x', 'y', 'width', 'height', 'z'].every((key) => finite(node[key as keyof CanvasNode])) ||
      node.width < 0 ||
      node.height < 0 ||
      !object(node.data) ||
      !['text', 'image', 'video', 'timeline', 'storyboard'].includes(node.type)
    )
      throw new Error('invalid_canvas_node')
    const data = node.data
    if (
      node.type === 'text' &&
      node.data.richText !== undefined &&
      !isCanvasTextDelta(node.data.richText)
    )
      throw new Error('invalid_canvas_text')
    if (
      'name' in data &&
      data.name !== undefined &&
      (typeof data.name !== 'string' || data.name.length > 500)
    )
      throw new Error('invalid_canvas_node')
    if (node.type === 'video' && !object(data.video)) throw new Error('invalid_canvas_node')
    if (node.type === 'image' || node.type === 'video') {
      if (
        !allowed(data, [
          'fileId',
          'mediaId',
          'rotation',
          'name',
          'naturalWidth',
          'naturalHeight',
          'createdAt',
          'groupId',
          'meta',
          'pending',
          'video',
        ])
      )
        throw new Error('invalid_canvas_node')
      // mediaId 要么没有，要么是合法的云媒体 id：null、空串或任意字符串都不能混进来。
      if ('mediaId' in data && data.mediaId !== undefined && !isMediaId(data.mediaId))
        throw new Error('invalid_canvas_node')
      // 本机原图还在上传的节点先同步位置等改动：没有 mediaId 时 fileId 只是上传那台设备的本机 id，
      // 别处只当「上传中」显示；拿到 mediaId 后 fileId 必须换成 cloud-<mediaId>。
      if (
        'fileId' in data &&
        data.fileId !== undefined &&
        ('mediaId' in data && data.mediaId !== undefined
          ? data.fileId !== `cloud-${data.mediaId}`
          : !isLocalCanvasFileId(data.fileId))
      )
        throw new Error('canvas_media_not_ready')
      // Validate empty nodes with the same persisted media schema as completed ones.
      const { fileId: _file, pending: _pending, ...image } = data
      if (
        !isProjectDocument({
          version: 1,
          elements: [
            {
              ...image,
              id: node.id,
              x: node.x,
              y: node.y,
              width: node.width,
              height: node.height,
              type: 'image',
              rotation: data.rotation ?? 0,
              mediaId: data.mediaId ?? '00000000-0000-0000-0000-000000000000',
            },
          ],
        })
      )
        throw new Error('invalid_canvas_node')
      if (data.pending !== undefined) {
        const pending = data.pending
        if (!object(pending)) throw new Error('invalid_canvas_pending')
        if (pending.type === 'placeholder') {
          if (
            !allowed(pending, ['type', 'status', 'message', 'meta']) ||
            typeof pending.status !== 'string' ||
            !['loading', 'error', 'stale'].includes(pending.status) ||
            typeof pending.message !== 'string' ||
            !object(pending.meta)
          )
            throw new Error('invalid_canvas_pending')
        } else if (
          pending.type !== 'generation' ||
          !allowed(pending, ['type', 'generationId', 'position', 'errorCode']) ||
          !isProjectDocument({
            version: 1,
            elements: [
              {
                ...pending,
                id: node.id,
                x: node.x,
                y: node.y,
                width: node.width,
                height: node.height,
              },
            ],
          })
        )
          throw new Error('invalid_canvas_pending')
      }
    } else if (
      !allowed(
        data,
        node.type === 'text'
          ? ['text', 'fontSize', 'fill', 'name', 'richText']
          : node.type === 'storyboard'
            ? ['shots', 'confirmed', 'episode']
            : ['clips'],
      )
    )
      throw new Error('invalid_canvas_node')
    if (JSON.stringify(data).length > 100_000 || JSON.stringify(data).includes('data:image/'))
      throw new Error('invalid_canvas_node')
  }
  const jobs = doc.getMap('nodeJobs')
  if (jobs.size > 1000) throw new Error('canvas_document_too_large')
  for (const [key, job] of jobs) {
    if (
      !object(job) ||
      job.id !== key ||
      !id(key) ||
      !id(job.nodeId) ||
      !allowed(job, ['id', 'nodeId', 'createdAt', 'status', 'message', 'meta']) ||
      typeof job.createdAt !== 'number' ||
      !Number.isSafeInteger(job.createdAt) ||
      job.createdAt < 0 ||
      !['loading', 'error', 'stale'].includes(String(job.status)) ||
      typeof job.status !== 'string' ||
      typeof job.message !== 'string' ||
      job.message.length > 10000 ||
      !object(job.meta) ||
      !allowed(job.meta, [
        'nodeGeneration',
        'nodeVideo',
        'prompt',
        'source',
        'clientRequestId',
        'bffRequestId',
        'params',
        'generation',
        'inputFingerprint',
        'assetViewLabel',
        'adopted',
        'initialResultId',
      ]) ||
      (job.meta.nodeGeneration !== true && job.meta.nodeVideo !== true) ||
      (job.meta.nodeGeneration !== undefined && job.meta.nodeGeneration !== true) ||
      (job.meta.nodeVideo !== undefined && job.meta.nodeVideo !== true) ||
      (job.meta.nodeGeneration === true && job.meta.nodeVideo === true) ||
      (job.meta.source !== undefined &&
        !['builtin-edge', 'user-byok'].includes(String(job.meta.source))) ||
      (job.meta.params !== undefined && !object(job.meta.params)) ||
      (job.meta.generation !== undefined && !isVideoGenerationRecord(job.meta.generation)) ||
      (job.meta.assetViewLabel !== undefined &&
        (job.meta.assetViewLabel !== 'sheet' || job.meta.nodeGeneration !== true)) ||
      (job.meta.initialResultId !== undefined && !id(job.meta.initialResultId)) ||
      (job.meta.inputFingerprint !== undefined &&
        (typeof job.meta.inputFingerprint !== 'string' ||
          !/^v1:[0-9]+:[a-f0-9]+:[a-f0-9]+$/.test(job.meta.inputFingerprint))) ||
      typeof job.meta.prompt !== 'string' ||
      job.meta.prompt.length > 100000 ||
      !id(job.meta.clientRequestId) ||
      (job.meta.bffRequestId !== undefined && !id(job.meta.bffRequestId)) ||
      JSON.stringify(job.meta).length > 100000 ||
      JSON.stringify(job.meta).includes('data:image/')
    )
      throw new Error('invalid_canvas_job')
  }
  const results = doc.getMap('nodeResults')
  if (results.size > 10000) throw new Error('canvas_document_too_large')
  for (const [key, result] of results) {
    if (
      !object(result) ||
      !id(key) ||
      result.id !== key ||
      !id(result.nodeId) ||
      (result.kind !== 'image' && result.kind !== 'video') ||
      !allowed(result, [
        'id',
        'nodeId',
        'kind',
        'source',
        'createdAt',
        'inputFingerprint',
        'assetViewLabel',
        'adopted',
        'display',
      ]) ||
      (result.assetViewLabel !== undefined &&
        (result.assetViewLabel !== 'sheet' || result.kind !== 'image')) ||
      (result.adopted !== undefined && result.adopted !== true) ||
      typeof result.createdAt !== 'number' ||
      !Number.isSafeInteger(result.createdAt) ||
      result.createdAt < 0 ||
      (result.inputFingerprint !== undefined &&
        (typeof result.inputFingerprint !== 'string' ||
          !/^v1:[0-9]+:[a-f0-9]+:[a-f0-9]+$/.test(result.inputFingerprint))) ||
      !object(result.source)
    )
      throw new Error('invalid_canvas_result')
    if (result.display !== undefined) {
      const display = result.display
      const { fileId: _cache, ...persistedDisplay } = object(display) ? display : {}
      if (
        !object(display) ||
        !allowed(display, ['fileId', 'mediaId', 'naturalWidth', 'naturalHeight', 'video']) ||
        (display.mediaId !== undefined && !isMediaId(display.mediaId)) ||
        (display.fileId !== undefined &&
          (!display.mediaId || display.fileId !== `cloud-${display.mediaId}`)) ||
        (result.kind === 'video' ? !object(display.video) : display.video !== undefined) ||
        !isProjectDocument({
          version: 1,
          elements: [
            {
              ...persistedDisplay,
              id: key,
              type: 'image',
              x: 0,
              y: 0,
              width: 1,
              height: 1,
              rotation: 0,
              mediaId: display.mediaId ?? '00000000-0000-0000-0000-000000000000',
            },
          ],
        })
      )
        throw new Error('invalid_canvas_result')
    }
    const source = result.source
    if (source.type === 'queue' || source.type === 'local') {
      if (
        !allowed(source, ['type', 'taskId', 'outputIndex']) ||
        !id(source.taskId) ||
        !Number.isSafeInteger(source.outputIndex) ||
        Number(source.outputIndex) < 0 ||
        Number(source.outputIndex) > 1000
      )
        throw new Error('invalid_canvas_result')
    } else if (
      source.type !== 'media' ||
      !allowed(source, ['type', 'mediaId']) ||
      !isMediaId(source.mediaId)
    ) {
      throw new Error('invalid_canvas_result')
    }
  }
  for (const [nodeId, resultId] of doc.getMap('mainResults')) {
    const result = typeof resultId === 'string' ? results.get(resultId) : undefined
    if (!id(nodeId) || !object(result) || result.nodeId !== nodeId)
      throw new Error('invalid_canvas_result')
  }
  const groups = doc.getMap<Y.Map<unknown>>('groups')
  if (groups.size > 1000 || doc.getMap('groupMembers').size > 10000)
    throw new Error('canvas_document_too_large')
  for (const [key, group] of groups) {
    if (!(group instanceof Y.Map)) throw new Error('invalid_canvas_group')
    const value = group.toJSON()
    if (
      value.id !== key ||
      !id(key) ||
      doc.getMap('nodes').has(key) ||
      !allowed(value, ['id', 'name', 'x', 'y', 'width', 'height']) ||
      typeof value.name !== 'string' ||
      value.name.length > 500 ||
      !['x', 'y', 'width', 'height'].every((key) => finite(value[key])) ||
      value.width < 0 ||
      value.height < 0
    )
      throw new Error('invalid_canvas_group')
  }
  for (const [nodeId, groupId] of doc.getMap('groupMembers'))
    if (!id(nodeId) || !id(groupId)) throw new Error('invalid_canvas_group')
  // Deletion and concurrent edge insertion may leave dangling edges; they are inert, not corrupt data.
  for (const edge of edges)
    if (
      !object(edge) ||
      !allowed(edge, ['id', 'source', 'target']) ||
      !id(edge.source) ||
      !id(edge.target) ||
      edge.source === edge.target ||
      edge.id !== `${edge.source}:${edge.target}`
    )
      throw new Error('invalid_canvas_edge')
  const recorded = doc.getMap<string>('legacyConnections')
  if (
    recorded.size !== Object.keys(legacyConnections).length ||
    [...recorded].some(([key, value]) => legacyConnections[key] !== value)
  )
    throw new Error('invalid_canvas_connection_policy')
  const currentNodes = new Map(nodes.map((node) => [node.id, node]))
  for (const edge of edges) {
    const source = currentNodes.get(edge.source),
      target = currentNodes.get(edge.target)
    if (!source || !target || canvasConnectionAllowed(source, target)) continue
    if (legacyConnections[edge.id] === connectionSignature(source, target)) continue
    throw new Error('invalid_canvas_connection')
  }
  for (const key of ['deletedNodes', 'managedNodes']) {
    for (const [name, value] of doc.getMap(key))
      if (!id(name) || value !== true) throw new Error('invalid_canvas_document')
  }
  if (
    [...doc.getMap('meta')].some(
      ([key, value]) => !['legacyImported', 'connectionRules'].includes(key) || value !== true,
    )
  )
    throw new Error('invalid_canvas_document')
  if (
    new TextEncoder().encode(JSON.stringify(doc.toJSON())).length > 512 * 1024 ||
    !isProjectDocument(canvasProjectDocument(doc, identity))
  )
    throw new Error('invalid_canvas_document')
}

function connectionSignature(source: CanvasNode, target: CanvasNode): string {
  return JSON.stringify([source.id, target.id, canvasNodeKind(source), canvasNodeKind(target)])
}

/** Server-only migration: call on the trusted stored document before applying any client update. */
export function initializeCanvasConnectionRules(doc: Y.Doc): boolean {
  if (doc.getMap('meta').get('connectionRules')) return false
  const { nodes, edges } = readCanvasDocument(doc)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  doc.transact(() => {
    const legacy = doc.getMap<string>('legacyConnections')
    for (const edge of edges) {
      const source = byId.get(edge.source),
        target = byId.get(edge.target)
      if (source && target && !canvasConnectionAllowed(source, target))
        legacy.set(edge.id, connectionSignature(source, target))
    }
    doc.getMap('meta').set('connectionRules', true)
  }, 'system:connection-rules')
  return true
}
