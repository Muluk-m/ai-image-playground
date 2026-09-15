import { scopedStorageName } from '../../../lib/authScope'
import { type AgentDraft, EMPTY_DRAFT } from './references'

const sessions = new Map<string, DraftSession>()
const DB_NAME = 'image-playground-agent-drafts'
let database: Promise<IDBDatabase> | undefined

function openDatabase(): Promise<IDBDatabase> {
  if (!database) {
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => request.result.createObjectStore('drafts')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    database.catch(() => {
      database = undefined
    })
  }
  return database
}

export interface DraftSnapshot {
  readonly draft: AgentDraft
  readonly loading: boolean
  readonly submitting: boolean
  readonly error: string | null
}

/** 草稿独立于输入框的挂载周期；每个账号、会话各保留一份。 */
export class DraftSession {
  private snapshot: DraftSnapshot = {
    draft: EMPTY_DRAFT,
    loading: true,
    submitting: false,
    error: null,
  }
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private writes: Promise<void> = Promise.resolve()
  private revision = 0
  private savedRevision = 0
  private submission = 0
  private previousKey: string | undefined

  constructor(public key: string) {
    void this.restore()
  }

  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private publish(patch: Partial<DraftSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  private async restore() {
    try {
      const db = await openDatabase()
      const stored = await new Promise<AgentDraft | undefined>((resolve, reject) => {
        const request = db.transaction('drafts').objectStore('drafts').get(this.key)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      if (
        this.revision === 0 &&
        stored &&
        typeof stored.prompt === 'string' &&
        Array.isArray(stored.references)
      ) {
        this.publish({ draft: stored })
      }
    } catch {
      this.publish({ error: '草稿暂时无法读取或保存，刷新前请复制输入内容。' })
    } finally {
      this.publish({ loading: false })
    }
  }

  update = (change: AgentDraft | ((draft: AgentDraft) => AgentDraft)) => {
    const draft = typeof change === 'function' ? change(this.snapshot.draft) : change
    if (draft === this.snapshot.draft) return
    this.revision += 1
    this.publish({ draft })
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.flush()
    }, 300)
  }

  moveTo(key: string) {
    this.previousKey = this.key
    this.key = key
    this.revision += 1
    void this.flush()
  }

  setSubmitting(submitting: boolean) {
    this.submission += 1
    this.publish({ submitting })
  }

  beginSubmission(): () => void {
    this.setSubmitting(true)
    const submission = this.submission
    return () => {
      if (this.submission === submission) this.publish({ submitting: false })
    }
  }

  accept(draft: AgentDraft) {
    if (this.snapshot.draft === draft) this.update(EMPTY_DRAFT)
    void this.flush()
  }

  flush = (): Promise<void> => {
    clearTimeout(this.timer)
    if (this.revision === this.savedRevision) return this.writes
    const revision = this.revision
    const draft = this.snapshot.draft
    const key = this.key
    const previousKey = this.previousKey
    this.writes = this.writes.then(async () => {
      try {
        const db = await openDatabase()
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction('drafts', 'readwrite')
          transaction.objectStore('drafts').put(draft, key)
          if (previousKey) transaction.objectStore('drafts').delete(previousKey)
          transaction.oncomplete = () => resolve()
          transaction.onabort = () => reject(transaction.error)
          transaction.onerror = () => reject(transaction.error)
        })
        this.savedRevision = Math.max(this.savedRevision, revision)
        if (this.previousKey === previousKey) this.previousKey = undefined
        this.publish({ error: null })
      } catch {
        this.publish({ error: '草稿保存失败，内容仍在当前页面，刷新前请复制。' })
      }
    })
    return this.writes
  }
}

export function agentDraft(conversationId: string | null): DraftSession {
  const key = scopedStorageName(`agent-draft:${conversationId ?? 'new'}`)
  let session = sessions.get(key)
  if (!session) {
    session = new DraftSession(key)
    sessions.set(key, session)
  }
  return session
}

/** 首条消息创建会话时沿用同一份草稿，避免上传中的输入突然切到空草稿。 */
export function bindNewAgentDraft(conversationId: string): void {
  const oldKey = scopedStorageName('agent-draft:new')
  const session = sessions.get(oldKey)
  if (!session) return
  const key = scopedStorageName(`agent-draft:${conversationId}`)
  session.moveTo(key)
  sessions.set(key, session)
  sessions.delete(oldKey)
}
