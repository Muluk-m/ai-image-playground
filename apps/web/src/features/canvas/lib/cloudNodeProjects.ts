import {
  CANVAS_UPLOAD_DEVICE_META,
  CANVAS_UPLOAD_STARTED_META,
  canvasOrigin,
  canvasProjectDocument,
  canvasResults,
  canvasSyncStep1,
  canvasSyncStep2,
  canvasUploadClaimedElsewhere,
  createCanvasUndoManager,
  type ImageNodeData,
  importLegacyElements,
  isLocalCanvasFileId,
  type LegacyCanvasElement,
  type ProjectDocument,
  type ProjectVideoRef,
  projectKind,
  promoteCanvasResultMedia,
  promoteCanvasStoredResult,
  promoteCanvasVideoMedia,
  readCanvasDocument,
  readCanvasSyncMessage,
  synchronizeLegacyElements,
  updateCanvasNode,
} from '@image-playground/shared'
import i18next from 'i18next'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'
import { authenticatedBffFetch } from '../../../lib/authClient'
import { accountScope, scopedStorageName } from '../../../lib/authScope'
import { supportsCanvasPendingMedia } from '../../../lib/clientCapabilities'
import { MediaRequestError, mediaIdentity, mediaJson } from '../../../lib/cloudMedia'
import { getDeviceId } from '../../../lib/deviceId'
import { uploadMediaSource } from '../../../lib/mediaUpload'
import { bffBaseUrl } from '../../../lib/runtimeConfig'
import { useStore } from '../../../store'
import type { CloudProjectSession, ProjectSyncSnapshot, ProjectSyncStatus } from './cloudProjects'
import type { NodeCanvasDocument } from './nodeCanvasDocument'
import { nodeCanvasDatabaseName } from './nodeCanvasDocument'
import { type CanvasCommandSummary, CloudCanvasHistory } from './nodeCanvasHistory'
import { writePersistedScene } from './persistence'
import { getCloudProject, ProjectRequestError, putCloudProject } from './projectClient'
import {
  archivedProjectKind,
  type LoadedBindings,
  MEDIA_CONCURRENCY,
  projectDocument,
  projectScene,
} from './projectMedia'
import { type CanvasProject, projectRepository } from './projectRepository'
import type { SceneRecord } from './sceneRecord'

const remoteOrigin = canvasOrigin('system', 'cloud-sync')
const legacyOrigin = canvasOrigin('system', 'legacy-editor')
type CommandReadPurpose = 'passive' | 'after-reverse'
export type CanvasCloudSession = CloudProjectSession | CloudNodeProjectSession

/** One persisted Y.Doc per cloud workspace. UI mounts do not own the connection or its lifetime. */
export class CloudNodeProjectSession {
  canvas: NodeCanvasDocument | undefined
  private persistence: IndexeddbPersistence | undefined
  private socket: WebSocket | undefined
  private stopLegacy: (() => void) | undefined
  private controller = new AbortController()
  private readonly sameAccount = accountScope()
  private listeners = new Set<() => void>()
  private state: ProjectSyncSnapshot = {
    status: 'loading',
    message: null,
  }
  /** 后台上传这一批本机图片的进度；文档改动不等它，先同步。 */
  private upload: { done: number; total: number } | undefined
  private uploading: Promise<void> | undefined
  private uploadAgain = false
  /** 最近一轮后台上传的失败；下一轮成功前，确认回执不算「已保存」。 */
  private mediaFailure: unknown
  private retry: ReturnType<typeof setTimeout> | undefined
  private debounce: ReturnType<typeof setTimeout> | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private retries = 0
  private serverVector: Uint8Array | undefined
  private preparing: Promise<void> = Promise.resolve()
  private localRenaming: Promise<void> = Promise.resolve()
  private renaming: Promise<void> = Promise.resolve()
  private applying = false
  private identity: ProjectDocument
  private bindings = new Map<string, string>()
  private editVersion = 0
  private sentVersion: number | undefined
  /** 服务端最近确认到的本机版本；后台上传收尾时据此判断还要不要再发一次。 */
  private ackedVersion: number | undefined
  private loading: Promise<void> | undefined
  private commandHistory: CloudCanvasHistory | undefined
  private readingCommands: Promise<void> | undefined
  private remoteDeleted = false
  private waits = new Set<{ resolve(): void; reject(error: unknown): void }>()
  constructor(
    private project: CanvasProject,
    private record: SceneRecord,
    private publish: (project: CanvasProject) => void,
  ) {
    this.identity = {
      version: 1,
      elements: [],
      kind: archivedProjectKind(record.checkpoint) ?? project.kind,
      experience: project.experience,
      sourceProjectId: project.sourceProjectId,
    }
  }
  get projectId() {
    return this.project.id
  }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private current() {
    if (this.controller.signal.aborted || !this.sameAccount())
      throw new Error('project_scope_changed')
  }
  private status(status: ProjectSyncStatus) {
    if (this.controller.signal.aborted) return
    this.state = { status, message: null, ...(this.upload ? { upload: { ...this.upload } } : {}) }
    for (const listener of this.listeners) listener()
  }
  private progress(upload: { done: number; total: number } | undefined) {
    this.upload = upload
    this.status(this.state.status)
  }
  load(_hasLocal = false): Promise<void> {
    return (this.loading ??= this.open().catch((error) => {
      this.loading = undefined
      this.status('load-error')
      throw error
    }))
  }
  private async open() {
    const doc = new Y.Doc({ guid: scopedStorageName(nodeCanvasDatabaseName(this.record.key)) })
    const persistence = new IndexeddbPersistence(nodeCanvasDatabaseName(this.record.key), doc)
    this.persistence = persistence
    try {
      await persistence.whenSynced
      this.current()
      // Preserve the browser's pre-migration scene, including unsent images and local geometry.
      if (!doc.getMap('meta').get('legacyImported') && this.record.editor.doc.elements.length)
        await writePersistedScene(this.record.contents(), `${this.record.key}:pre-node-migration`)
      try {
        let remote
        let created = false
        const needsMigration = !doc.getMap('meta').get('legacyImported')
        try {
          remote = await getCloudProject(this.project.id, this.controller.signal)
        } catch (error) {
          if (
            !(error instanceof ProjectRequestError && error.status === 404) ||
            this.project.cloud?.revision
          )
            throw error
          // Create an empty server document; this device's full Y.Doc is merged after media preparation.
          try {
            await putCloudProject(
              this.project.id,
              {
                requestId: crypto.randomUUID(),
                baseRevision: 0,
                name: this.project.name,
                document: this.identity,
              },
              this.controller.signal,
            )
            created = true
          } catch (writeError) {
            if (!(writeError instanceof ProjectRequestError && writeError.status === 409))
              throw writeError
          }
          remote = await getCloudProject(this.project.id, this.controller.signal)
        }
        this.current()
        this.identity = remote.document
        if (needsMigration && !created && this.record.editor.doc.elements.length) {
          const bindings: LoadedBindings = new Map(
            Object.entries(this.record.checkpoint?.media ?? {}).map(([fileId, binding]) => [
              fileId,
              { ...binding, source: this.record.editor.doc.files[fileId] ?? '' },
            ]),
          )
          const legacyKind = archivedProjectKind(this.record.checkpoint) ?? this.project.kind
          const local = projectDocument(this.record.editor.doc, bindings, legacyKind, this.project)
          const stable = (value: unknown) =>
            JSON.stringify(value, (_key, item) =>
              item && typeof item === 'object' && !Array.isArray(item)
                ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
                : item,
            )
          const saved = this.record.checkpoint?.savedContent
          let dirty = true
          try {
            dirty =
              !local || !saved || stable([this.project.name, local]) !== stable(JSON.parse(saved))
          } catch {
            /* retain an unreadable old checkpoint as a recovery copy */
          }
          if (dirty)
            this.publish(
              await projectRepository.createRecoveryCopy(
                { ...this.project, kind: legacyKind },
                this.record.contents(),
              ),
            )
        }
        if (created)
          importLegacyElements(
            doc,
            this.record.editor.doc.elements as readonly LegacyCanvasElement[],
            legacyOrigin,
          )
        const response = await authenticatedBffFetch(
          `${bffBaseUrl()}/api/projects/${this.project.id}/canvas`,
          { signal: this.controller.signal, cache: 'no-store' },
        )
        if (!response.ok) throw new ProjectRequestError(response.status, 'canvas_load_failed')
        Y.applyUpdate(doc, new Uint8Array(await response.arrayBuffer()), remoteOrigin)
        this.current()
        this.project = await projectRepository.update(this.project.id, {
          cloud: { revision: remote.revision },
          name: this.project.cloud?.nameDirty ? this.project.name : remote.name,
          hasContent: readCanvasDocument(doc).nodes.length > 0,
        })
        this.publish(this.project)
      } catch (error) {
        // 410 means the server copy is gone. The local scene still has to open, so the
        // edit can be saved as a new project. Other client errors, and a first open that
        // never imported a Y.Doc, still fail. A later network loss can use the Y.Doc.
        const deleted = error instanceof ProjectRequestError && error.status === 410
        if (deleted) {
          importLegacyElements(
            doc,
            this.record.editor.doc.elements as readonly LegacyCanvasElement[],
            legacyOrigin,
          )
          this.remoteDeleted = true
        } else if (
          (error instanceof ProjectRequestError && error.status < 500 && error.status !== 429) ||
          !doc.getMap('meta').get('legacyImported')
        )
          throw error
        else this.status('offline')
      }
      this.current()
      const origin = canvasOrigin('user', crypto.randomUUID())
      const normalizeMedia = () => {
        for (const node of readCanvasDocument(doc).nodes) {
          if (
            (node.type === 'image' || node.type === 'video') &&
            node.data.mediaId &&
            !node.data.fileId
          )
            updateCanvasNode(
              doc,
              node.id,
              { data: { ...node.data, fileId: `cloud-${node.data.mediaId}` } },
              remoteOrigin,
            )
        }
      }
      normalizeMedia()
      const undo = new CloudCanvasHistory(
        createCanvasUndoManager(doc, origin),
        async (command) => {
          await this.sync()
          const response = await authenticatedBffFetch(
            `${bffBaseUrl()}/api/projects/${this.project.id}/canvas/commands/${command.id}/reverse`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ revision: command.revision }),
              signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
            },
          )
          if (!response.ok) {
            await this.readCommands('after-reverse')
            throw new ProjectRequestError(response.status, 'canvas_command_reverse_failed')
          }
          this.current()
          Y.applyUpdate(doc, new Uint8Array(await response.arrayBuffer()), remoteOrigin)
          await this.readCommands('after-reverse')
        },
        (error) => {
          if (error instanceof Error && error.message === 'canvas_undo_history_too_large')
            useStore.getState().showToast(i18next.t('nodes.historyFull', { ns: 'canvas' }), 'error')
          else this.status('offline')
        },
      )
      this.commandHistory = undo
      this.canvas = { doc, origin, undo, destroy: async () => {} }
      let previous = this.record.editor.doc.elements as readonly LegacyCanvasElement[]
      this.stopLegacy = this.record.editor.doc.subscribe(() => {
        const next = this.record.editor.doc.elements as readonly LegacyCanvasElement[]
        const before = previous
        previous = next
        if (!this.applying) synchronizeLegacyElements(doc, before, next, legacyOrigin)
      })
      doc.on('update', (_update: Uint8Array, origin: unknown) => {
        normalizeMedia()
        this.projectToEditor()
        if (origin !== remoteOrigin) {
          this.editVersion++
          this.status('pending')
          this.requestSync()
        }
      })
      this.projectToEditor()
      if (this.remoteDeleted) this.status('deleted')
      else this.start()
    } catch (error) {
      await persistence.destroy()
      doc.destroy()
      throw error
    }
  }
  /** Legacy adapters (Agent attachments, exports, generation sinks) read a projection, not a second cloud writer. */
  private projectToEditor() {
    if (!this.canvas || this.applying) return
    const editor = this.record.editor
    const scene = projectScene(
      canvasProjectDocument(this.canvas.doc, this.identity),
      undefined,
      this.project.conversationId,
    )
    const nodes = readCanvasDocument(this.canvas.doc).nodes
    for (const node of nodes) {
      if (
        (node.type === 'image' || node.type === 'video') &&
        !node.data.fileId &&
        !node.data.mediaId &&
        node.data.pending?.type === 'placeholder'
      ) {
        const meta = node.data.pending.meta
        scene.elements.push({
          ...node.data.pending,
          meta: {
            ...meta,
            taskId: 'taskId' in meta && typeof meta.taskId === 'string' ? meta.taskId : node.id,
            clientRequestId:
              'clientRequestId' in meta && typeof meta.clientRequestId === 'string'
                ? meta.clientRequestId
                : '',
            source: 'source' in meta && meta.source === 'user-byok' ? 'user-byok' : 'builtin-edge',
            prompt: 'prompt' in meta && typeof meta.prompt === 'string' ? meta.prompt : '',
          },
          status:
            node.data.pending.status === 'loading'
              ? 'loading'
              : node.data.pending.status === 'stale'
                ? 'stale'
                : 'error',
          id: node.id,
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height,
        })
      }
      if (
        (node.type === 'image' || node.type === 'video') &&
        (node.data.fileId || node.type === 'video' || node.data.meta?.nodeKind === 'video') &&
        !node.data.mediaId
      ) {
        // Timeline preview/export must see videos even before a poster exists.
        const { pending: _pending, ...data } = node.data
        scene.elements.push({
          ...data,
          id: node.id,
          type: 'image',
          fileId: node.data.fileId ?? '',
          x: node.x,
          y: node.y,
          width: node.width,
          height: node.height,
          rotation: node.data.rotation ?? 0,
        })
      }
    }
    this.applying = true
    try {
      editor.doc.restore(scene.elements, { ...editor.doc.files, ...scene.files }, editor.doc.camera)
    } finally {
      this.applying = false
    }
  }
  start() {
    window.removeEventListener('online', this.resume)
    window.addEventListener('online', this.resume)
    this.connect()
  }
  private resume = () => {
    this.retries = 0
    this.connect()
  }
  private connect() {
    if (
      !this.canvas ||
      this.controller.signal.aborted ||
      !this.sameAccount() ||
      this.socket ||
      navigator.onLine === false
    )
      return
    clearTimeout(this.retry)
    const url = new URL(`${bffBaseUrl()}/api/projects/${this.project.id}/canvas/ws`, location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    this.socket = socket
    socket.binaryType = 'arraybuffer'
    this.status('syncing')
    socket.onopen = () => {
      if (this.socket !== socket || !this.canvas) return
      socket.send(canvasSyncStep1(this.canvas.doc))
      this.heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN && this.canvas)
          socket.send(canvasSyncStep1(this.canvas.doc))
      }, 20_000)
    }
    socket.onmessage = (event) => {
      if (this.socket !== socket || !this.canvas) return
      try {
        this.current()
        const message = readCanvasSyncMessage(new Uint8Array(event.data))
        if (message.kind === 'update') {
          Y.applyUpdate(this.canvas.doc, message.value, remoteOrigin)
          void this.readCommands().catch(() => {})
        } else if (message.kind === 'vector') {
          this.serverVector = message.value
          void this.readCommands().catch(() => {})
          this.requestSync()
        } else {
          this.serverVector = message.value
          const version = this.sentVersion
          this.sentVersion = undefined
          if (version === this.editVersion) {
            this.ackedVersion = version
            this.saved()
          } else this.requestSync()
        }
      } catch {
        this.status('format-error')
        socket.close(1008)
      }
    }
    socket.onclose = (event) => {
      if (this.socket !== socket) return
      this.socket = undefined
      this.sentVersion = undefined
      clearInterval(this.heartbeat)
      if (this.controller.signal.aborted) return
      if (event.code === 1008 || event.code === 4004) {
        this.status(event.code === 4004 ? 'deleted' : 'permission-error')
        this.rejectWaits(new Error(event.reason))
        return
      }
      this.status('offline')
      this.retry = setTimeout(() => this.connect(), Math.min(30_000, 1000 * 2 ** this.retries++))
    }
  }
  private saved() {
    this.retries = 0
    // 文档已经落盘，图片还在后台上传：还没全部保存，sync() 的等待者要等图片收进文档、再确认一次。
    if (this.uploading) return this.status('syncing')
    if (this.mediaFailure !== undefined) return this.status('media-local')
    this.status(this.missingVideos.size ? 'media-local' : 'saved')
    for (const wait of this.waits) wait.resolve()
    this.waits.clear()
  }
  private rejectWaits(error: unknown) {
    for (const wait of this.waits) wait.reject(error)
    this.waits.clear()
  }
  private readonly missingVideos = new Set<string>()
  private async prepareVideoMedia() {
    if (!this.canvas) return
    const doc = this.canvas.doc
    const videos: ProjectVideoRef[] = readCanvasDocument(doc).nodes.flatMap((node) =>
      node.type === 'video' ? [node.data.video] : [],
    )
    for (const result of canvasResults(doc)) {
      if (
        result.display?.video &&
        (result.adopted || result.display.fileId || result.display.mediaId)
      )
        videos.push(result.display.video)
    }
    const unique = new Map(
      videos
        .filter((video) => !video.mediaId)
        .map((video) => [JSON.stringify([video.taskId, video.outputIndex]), video]),
    )
    for (const key of this.missingVideos) if (!unique.has(key)) this.missingVideos.delete(key)
    for (const [key, video] of unique) {
      if (this.missingVideos.has(key)) continue
      try {
        const media = await mediaJson<{ id: string }>(
          '/video-outputs',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ taskId: video.taskId, outputIndex: video.outputIndex }),
            signal: this.controller.signal,
          },
          130_000,
        )
        this.current()
        promoteCanvasVideoMedia(doc, video, media.id, legacyOrigin)
      } catch (error) {
        // An already-expired legacy video must not prevent saving unrelated document edits.
        if (!(error instanceof MediaRequestError && error.status === 404)) throw error
        this.missingVideos.add(key)
      }
    }
  }
  private async prepareMedia() {
    if (!this.canvas) return
    const doc = this.canvas.doc
    // 先列出这一轮要收成云媒体的全部本机原图，按原图去重：同一张图挂在几个节点或候选上只传一次。
    const nodes: { nodeId: string; fileId: string; elsewhere: boolean }[] = []
    const device = getDeviceId()
    for (const node of readCanvasDocument(doc).nodes) {
      if (
        (node.type !== 'image' && node.type !== 'video') ||
        !node.data.fileId ||
        node.data.mediaId
      )
        continue
      nodes.push({
        nodeId: node.id,
        fileId: node.data.fileId,
        elsewhere: canvasUploadClaimedElsewhere(node.data, device),
      })
    }
    // Previously chosen candidates remain durable even after another candidate becomes main.
    const results: { resultId: string; fileId: string }[] = []
    for (const result of canvasResults(doc)) {
      const fileId =
        result.source.type === 'file'
          ? result.source.fileId
          : !result.display?.mediaId
            ? result.display?.fileId
            : undefined
      if (fileId) results.push({ resultId: result.id, fileId })
    }
    let failure: unknown
    const sources = new Set<string>()
    // 别的设备声明在传的上传中节点，本机没有原图是正常的，由那台设备去传；
    // 本机缺原图又没有别人声明在传（原图被清理、损坏），仍按缺图报错。
    const pendingAllowed = supportsCanvasPendingMedia()
    for (const node of nodes) {
      const source = this.record.editor.doc.files[node.fileId]
      if (source) sources.add(source)
      else if (!pendingAllowed || !node.elsewhere) failure ??= new Error('canvas_media_missing')
    }
    for (const { fileId } of results) {
      const source = this.record.editor.doc.files[fileId]
      if (source) sources.add(source)
      else failure ??= new Error('canvas_media_missing')
    }
    const promote = (source: string, mediaId: string) => {
      for (const { nodeId, fileId } of nodes) {
        if (this.record.editor.doc.files[fileId] !== source) continue
        const current = readCanvasDocument(doc).nodes.find((n) => n.id === nodeId)
        if (current && 'fileId' in current.data && current.data.fileId === fileId)
          promoteCanvasResultMedia(doc, nodeId, fileId, mediaId, legacyOrigin)
      }
      for (const { resultId, fileId } of results)
        if (this.record.editor.doc.files[fileId] === source)
          promoteCanvasStoredResult(doc, resultId, fileId, mediaId, legacyOrigin)
    }
    // 与旧画布 prepareProjectMedia 同一个写法：同时传 MEDIA_CONCURRENCY 张，传完一张就把它收进文档；
    // 一张失败不拦其余的，全部跑完再报第一条错，下次同步只剩失败的那几张。
    const queue: string[] = []
    for (const source of sources) {
      const known = mediaIdentity(source) ?? this.bindings.get(source)
      if (known) promote(source, known)
      else queue.push(source)
    }
    const total = queue.length
    let done = 0
    if (total) this.progress({ done, total })
    const worker = async () => {
      for (let source = queue.shift(); source !== undefined; source = queue.shift()) {
        try {
          const mediaId = (await uploadMediaSource(source, { signal: this.controller.signal }))?.id
          this.current()
          if (!mediaId) throw new Error('canvas_media_missing')
          this.bindings.set(source, mediaId)
          promote(source, mediaId)
          this.progress({ done: ++done, total })
        } catch (error) {
          failure ??= error
          if (this.controller.signal.aborted || !this.sameAccount()) return
        }
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(MEDIA_CONCURRENCY, total) }, worker))
    } finally {
      if (total) this.progress(undefined)
    }
    if (failure !== undefined) throw failure
  }
  requestSync = () => {
    clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = undefined
      void this.send()
    }, 80)
  }
  /**
   * 文档里只剩服务端也收的本机图片（上传中的图片节点、没有云媒体的视频）时，改动不用等上传。
   * 本机 file 来源的候选结果服务端不收，碰到它就照旧先收成云媒体再发。
   */
  private canSendBeforeMedia() {
    if (!this.canvas || !supportsCanvasPendingMedia()) return false
    if (
      canvasResults(this.canvas.doc).some(
        (result) =>
          result.source.type === 'file' || (!result.display?.mediaId && result.display?.fileId),
      )
    )
      return false
    // 本机缺原图、也没有别的设备声明在传的节点不能当「上传中」发出去：走原流程报缺图。
    const files = this.record.editor.doc.files
    const device = getDeviceId()
    return readCanvasDocument(this.canvas.doc).nodes.every(
      (node) =>
        (node.type !== 'image' && node.type !== 'video') ||
        !node.data.fileId ||
        !!node.data.mediaId ||
        !!files[node.data.fileId] ||
        canvasUploadClaimedElsewhere(node.data, device),
    )
  }
  /**
   * 先发文档前，给本机要传的节点写上「本设备在传、何时开始」：别的设备据此显示上传中，
   * 而不是把任何本机格式的 fileId 都当成有人在传。收成云媒体时由 promote 去掉。
   */
  private claimLocalUploads() {
    if (!this.canvas) return
    const doc = this.canvas.doc
    const files = this.record.editor.doc.files
    const device = getDeviceId()
    const now = String(Date.now())
    const claims: { id: string; data: ImageNodeData }[] = []
    for (const node of readCanvasDocument(doc).nodes) {
      if (node.type !== 'image' && node.type !== 'video') continue
      const { fileId, mediaId, meta } = node.data
      if (
        isLocalCanvasFileId(fileId) &&
        !mediaId &&
        files[fileId] &&
        meta?.[CANVAS_UPLOAD_DEVICE_META] !== device
      )
        claims.push({ id: node.id, data: node.data })
    }
    if (!claims.length) return
    doc.transact(() => {
      for (const { id, data } of claims)
        updateCanvasNode(
          doc,
          id,
          {
            data: {
              ...data,
              meta: {
                ...data.meta,
                [CANVAS_UPLOAD_DEVICE_META]: device,
                [CANVAS_UPLOAD_STARTED_META]: now,
              },
            },
          },
          legacyOrigin,
        )
    }, legacyOrigin)
  }
  /** 本机有原图、还没收成云媒体的图片节点；别的设备的上传中节点由那台设备传。 */
  private hasLocalImages() {
    if (!this.canvas) return false
    const files = this.record.editor.doc.files
    return readCanvasDocument(this.canvas.doc).nodes.some(
      (node) =>
        (node.type === 'image' || node.type === 'video') &&
        !!node.data.fileId &&
        !node.data.mediaId &&
        !!files[node.data.fileId],
    )
  }
  /** 一次只跑一轮后台上传；跑的时候又来了改动，就在这一轮结束后再补一轮。 */
  private uploadInBackground() {
    if (this.uploading) {
      this.uploadAgain = true
      return
    }
    this.uploading = (async () => {
      do {
        this.uploadAgain = false
        await this.prepareMedia()
        this.current()
      } while (this.uploadAgain)
    })()
      .then(
        () => {
          this.mediaFailure = undefined
        },
        (error: unknown) => {
          this.mediaFailure = error
        },
      )
      .finally(() => {
        this.uploading = undefined
        if (this.controller.signal.aborted) return
        if (this.mediaFailure === undefined) {
          // 收进文档的 mediaId 会自己触发同步。一张都没收（节点已删）且服务端已确认到最新版本时，
          // 直接收尾放行等待者；还有帧在途就交给它的回执。
          if (this.sentVersion === undefined && this.ackedVersion === this.editVersion) this.saved()
          else this.requestSync()
          return
        }
        this.status('media-local')
        this.rejectWaits(this.mediaFailure)
      })
  }
  private send(): Promise<void> {
    this.preparing = this.preparing
      .then(async () => {
        this.current()
        if (this.canSendBeforeMedia()) {
          // 视频收成云媒体照旧在发送前做（生成出的视频才有，与上传无关）；本机图片放到后台传。
          await this.prepareVideoMedia()
          if (this.project.cloud?.nameDirty) await this.flushName()
          this.current()
          if (this.hasLocalImages()) {
            this.claimLocalUploads()
            this.uploadInBackground()
          }
        } else {
          // Promotion awaits I/O; include edits made during those awaits before acknowledging this version.
          let preparedVersion: number
          do {
            preparedVersion = this.editVersion
            await this.prepareVideoMedia()
            await this.prepareMedia()
            if (this.project.cloud?.nameDirty) await this.flushName()
            this.current()
          } while (preparedVersion !== this.editVersion)
        }
        // 失败的那几张已经传上去或被删掉：不再拿上一轮的失败拦「已保存」。
        if (!this.uploading && !this.hasLocalImages()) this.mediaFailure = undefined
        if (!this.canvas || this.socket?.readyState !== WebSocket.OPEN || !this.serverVector) {
          this.connect()
          return
        }
        if (this.sentVersion !== undefined) return
        this.sentVersion = this.editVersion
        this.status('syncing')
        this.socket.send(canvasSyncStep2(this.canvas.doc, this.serverVector))
      })
      .catch((error) => {
        this.status('media-local')
        this.rejectWaits(error)
      })
    return this.preparing
  }
  sync = async (): Promise<void> => {
    await this.load()
    this.current()
    if (navigator.onLine === false) throw new Error('offline')
    return new Promise<void>((resolve, reject) => {
      const wait = {
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (error: unknown) => {
          clearTimeout(timer)
          reject(error)
        },
      }
      const timer = setTimeout(() => {
        this.waits.delete(wait)
        reject(new Error('canvas_sync_timeout'))
      }, 30_000)
      this.waits.add(wait)
      this.requestSync()
    })
  }
  private async readCommands(purpose: CommandReadPurpose = 'passive'): Promise<void> {
    if (purpose === 'after-reverse') {
      const previousRead = this.readingCommands
      if (previousRead) await previousRead.catch(() => {})
    }
    this.current()
    if (purpose === 'passive' && document.visibilityState === 'hidden') return
    if (this.readingCommands) return this.readingCommands
    this.readingCommands = (async () => {
      const response = await authenticatedBffFetch(
        `${bffBaseUrl()}/api/projects/${this.project.id}/canvas/commands`,
        {
          cache: 'no-store',
          signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15000)]),
        },
      )
      if (!response.ok) throw new ProjectRequestError(response.status, 'canvas_commands_failed')
      const commands: CanvasCommandSummary[] = await response.json()
      this.current()
      this.commandHistory?.accept(commands)
    })().finally(() => {
      this.readingCommands = undefined
    })
    return this.readingCommands
  }
  reload = () => {
    this.socket?.close()
    this.connect()
    return this.load()
  }
  refresh = async (_force = false) => {
    await this.load()
    this.current()
    const response = await authenticatedBffFetch(
      `${bffBaseUrl()}/api/projects/${this.project.id}/canvas`,
      {
        cache: 'no-store',
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15_000)]),
      },
    )
    if (!response.ok) throw new ProjectRequestError(response.status, 'canvas_load_failed')
    const update = new Uint8Array(await response.arrayBuffer())
    this.current()
    if (this.canvas) Y.applyUpdate(this.canvas.doc, update, remoteOrigin)
    this.projectToEditor()
    await this.readCommands()
  }
  knownMediaId(_fileId: string, source: string | undefined) {
    return source ? (mediaIdentity(source) ?? this.bindings.get(source)) : undefined
  }
  async mediaIdsFor(sources: readonly string[]) {
    const lookup = () =>
      new Map(
        sources.flatMap((source) => {
          const id = this.knownMediaId('', source)
          return id ? [[source, id] as const] : []
        }),
      )
    if (lookup().size === new Set(sources).size) return lookup()
    // A reference to a canvas original waits for its upload, then falls back to inline data.
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.sync(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('media_lookup_timeout')), 20_000)
        }),
      ])
    } catch {
      // Sync can fail or time out. Send the ids already known.
    } finally {
      clearTimeout(timer)
    }
    return lookup()
  }
  rename(
    name: string,
    custom = true,
    expectedName?: Parameters<typeof projectRepository.update>[2],
  ) {
    this.localRenaming = this.localRenaming
      .catch(() => {})
      .then(async () => {
        this.current()
        this.project = await projectRepository.update(
          this.project.id,
          { name, customName: custom, cloud: { ...this.project.cloud!, nameDirty: true } },
          expectedName,
        )
        this.publish(this.project)
      })
    return this.localRenaming.then(() => this.flushName())
  }
  private flushName() {
    this.renaming = this.renaming.catch(() => {}).then(() => this.persistName())
    return this.renaming
  }
  private async persistName() {
    this.current()
    if (!this.project.cloud?.nameDirty) return
    const name = this.project.name
    const response = await authenticatedBffFetch(
      `${bffBaseUrl()}/api/projects/${this.project.id}/canvas/name`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(10_000)]),
      },
    )
    if (!response.ok) throw new ProjectRequestError(response.status, 'canvas_rename_failed')
    this.current()
    this.localRenaming = this.localRenaming
      .catch(() => {})
      .then(async () => {
        this.current()
        if (this.project.name !== name) return
        this.project = await projectRepository.update(this.project.id, {
          cloud: { ...this.project.cloud!, nameDirty: false },
        })
        this.publish(this.project)
      })
    await this.localRenaming
  }
  async resolveConflict(_choice: 'cloud' | 'copy'): Promise<CanvasProject | undefined> {
    // Keep the complete CRDT graph in an independent local project when a cloud project is deleted.
    if (!this.canvas) return undefined
    const copy = await projectRepository.createRecoveryCopy(
      { ...this.project, kind: projectKind(this.identity) },
      this.record.contents(),
    )
    const doc = new Y.Doc()
    const persistence = new IndexeddbPersistence(nodeCanvasDatabaseName(copy.sceneKey), doc)
    await persistence.whenSynced
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(this.canvas.doc))
    await persistence.destroy()
    doc.destroy()
    this.publish(copy)
    return copy
  }
  dispose() {
    this.controller.abort()
    clearTimeout(this.retry)
    clearTimeout(this.debounce)
    clearInterval(this.heartbeat)
    window.removeEventListener('online', this.resume)
    this.stopLegacy?.()
    this.socket?.close()
    this.rejectWaits(new Error('project_scope_changed'))
    this.canvas?.undo.destroy()
    const doc = this.canvas?.doc
    void this.persistence?.destroy().finally(() => doc?.destroy())
    this.listeners.clear()
  }
}
