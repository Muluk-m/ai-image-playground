import {
  canvasOrigin,
  canvasProjectDocument,
  canvasSyncStep1,
  canvasSyncStep2,
  createCanvasUndoManager,
  importLegacyElements,
  type LegacyCanvasElement,
  type ProjectDocument,
  readCanvasDocument,
  readCanvasSyncMessage,
  synchronizeLegacyElements,
  updateCanvasNode,
} from '@image-playground/shared'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'
import { authenticatedBffFetch } from '../../../lib/authClient'
import { accountScope } from '../../../lib/authScope'
import { mediaIdentity } from '../../../lib/cloudMedia'
import { uploadMediaSource } from '../../../lib/mediaUpload'
import { bffBaseUrl } from '../../../lib/runtimeConfig'
import type { CloudProjectSession, ProjectSyncStatus } from './cloudProjects'
import type { NodeCanvasDocument } from './nodeCanvasDocument'
import { nodeCanvasDatabaseName } from './nodeCanvasDocument'
import { writePersistedScene } from './persistence'
import { getCloudProject, ProjectRequestError, putCloudProject } from './projectClient'
import { type LoadedBindings, projectDocument, projectScene } from './projectMedia'
import { type CanvasProject, projectRepository } from './projectRepository'
import type { SceneRecord } from './sceneRecord'

const remoteOrigin = canvasOrigin('system', 'cloud-sync')
const legacyOrigin = canvasOrigin('system', 'legacy-editor')
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
  private state: ReturnType<CloudProjectSession['getSnapshot']> = {
    status: 'loading',
    message: null,
  }
  private retry: ReturnType<typeof setTimeout> | undefined
  private debounce: ReturnType<typeof setTimeout> | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private retries = 0
  private serverVector: Uint8Array | undefined
  private preparing: Promise<void> = Promise.resolve()
  private applying = false
  private identity: ProjectDocument
  private bindings = new Map<string, string>()
  private editVersion = 0
  private sentVersion: number | undefined
  private loading: Promise<void> | undefined
  private waits = new Set<{ resolve(): void; reject(error: unknown): void }>()
  constructor(
    private project: CanvasProject,
    private record: SceneRecord,
    private publish: (project: CanvasProject) => void,
  ) {
    this.identity = {
      version: 1,
      elements: [],
      kind: project.kind,
      experience: project.experience,
      sourceProjectId: project.sourceProjectId,
    }
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
    this.state = { status, message: null }
    for (const listener of this.listeners) listener()
  }
  load(_hasLocal = false): Promise<void> {
    return (this.loading ??= this.open().catch((error) => {
      this.loading = undefined
      this.status('load-error')
      throw error
    }))
  }
  private async open() {
    const doc = new Y.Doc()
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
          const local = projectDocument(
            this.record.editor.doc,
            bindings,
            this.project.kind,
            this.project,
          )
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
              await projectRepository.createRecoveryCopy(this.project, this.record.contents()),
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
        // Network loss can use a previously opened Y.Doc; permission failures cannot.
        if (error instanceof ProjectRequestError || !doc.getMap('meta').get('legacyImported'))
          throw error
        this.status('offline')
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
      const undo = createCanvasUndoManager(doc, origin)
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
      this.start()
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
        node.data.fileId &&
        !node.data.mediaId
      ) {
        const { pending: _pending, ...data } = node.data
        scene.elements.push({
          ...data,
          id: node.id,
          type: 'image',
          fileId: node.data.fileId,
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
        if (message.kind === 'update') Y.applyUpdate(this.canvas.doc, message.value, remoteOrigin)
        else if (message.kind === 'vector') {
          this.serverVector = message.value
          this.requestSync()
        } else {
          this.serverVector = message.value
          const version = this.sentVersion
          this.sentVersion = undefined
          if (version === this.editVersion) this.saved()
          else this.requestSync()
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
    this.status('saved')
    for (const wait of this.waits) wait.resolve()
    this.waits.clear()
  }
  private rejectWaits(error: unknown) {
    for (const wait of this.waits) wait.reject(error)
    this.waits.clear()
  }
  private async prepareMedia() {
    if (!this.canvas) return
    for (const node of readCanvasDocument(this.canvas.doc).nodes) {
      if (
        (node.type !== 'image' && node.type !== 'video') ||
        !node.data.fileId ||
        node.data.mediaId
      )
        continue
      const source = this.record.editor.doc.files[node.data.fileId]
      if (!source) throw new Error('canvas_media_missing')
      const mediaId =
        mediaIdentity(source) ??
        this.bindings.get(source) ??
        (await uploadMediaSource(source, { signal: this.controller.signal }))?.id
      this.current()
      if (!mediaId) throw new Error('canvas_media_missing')
      this.bindings.set(source, mediaId)
      const current = readCanvasDocument(this.canvas.doc).nodes.find((n) => n.id === node.id)
      if (current && 'fileId' in current.data && current.data.fileId === node.data.fileId)
        updateCanvasNode(
          this.canvas.doc,
          node.id,
          { data: { ...current.data, mediaId, fileId: `cloud-${mediaId}` } },
          legacyOrigin,
        )
    }
  }
  requestSync = () => {
    clearTimeout(this.debounce)
    this.debounce = setTimeout(() => {
      this.debounce = undefined
      void this.send()
    }, 80)
  }
  private send(): Promise<void> {
    this.preparing = this.preparing
      .then(async () => {
        this.current()
        await this.prepareMedia()
        if (this.project.cloud?.nameDirty)
          await this.rename(this.project.name, this.project.customName)
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
  reload = () => {
    this.socket?.close()
    this.connect()
    return this.load()
  }
  refresh = async (_force = false) => {
    this.connect()
    if (this.socket?.readyState === WebSocket.OPEN && this.canvas)
      this.socket.send(canvasSyncStep1(this.canvas.doc))
  }
  knownMediaId(_fileId: string, source: string | undefined) {
    return source ? (mediaIdentity(source) ?? this.bindings.get(source)) : undefined
  }
  async mediaIdsFor(sources: readonly string[]) {
    await this.prepareMedia()
    return new Map(
      sources.flatMap((s) => {
        const id = this.knownMediaId('', s)
        return id ? [[s, id] as const] : []
      }),
    )
  }
  async rename(
    name: string,
    custom = true,
    expectedName?: Parameters<typeof projectRepository.update>[2],
  ) {
    this.project = await projectRepository.update(
      this.project.id,
      { name, customName: custom, cloud: { ...this.project.cloud!, nameDirty: true } },
      expectedName,
    )
    this.publish(this.project)
    const response = await authenticatedBffFetch(
      `${bffBaseUrl()}/api/projects/${this.project.id}/canvas/name`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: this.project.name }),
        signal: this.controller.signal,
      },
    )
    if (!response.ok) throw new ProjectRequestError(response.status, 'canvas_rename_failed')
    this.project = await projectRepository.update(this.project.id, {
      cloud: { ...this.project.cloud!, nameDirty: false },
    })
    this.publish(this.project)
  }
  async resolveConflict(_choice: 'cloud' | 'copy'): Promise<CanvasProject | undefined> {
    // Keep the complete CRDT graph in an independent local project when a cloud project is deleted.
    if (!this.canvas) return undefined
    const copy = await projectRepository.createRecoveryCopy(this.project, this.record.contents())
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
