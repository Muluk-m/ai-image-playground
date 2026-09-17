import { i18next } from '../../../i18n'
import { scopedStorageName } from '../../../lib/authScope'
import { flushOnPageHide } from '../../../lib/flushOnPageHide'
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

  readonly ready: Promise<void>

  constructor(
    public key: string,
    private fallbackKey?: string,
  ) {
    this.ready = this.restore()
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
        request.onsuccess = () => {
          if (request.result || !this.fallbackKey) {
            resolve(request.result)
            return
          }
          const fallback = db.transaction('drafts').objectStore('drafts').get(this.fallbackKey)
          fallback.onsuccess = () => resolve(fallback.result)
          fallback.onerror = () => reject(fallback.error)
        }
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
      this.publish({ error: i18next.t('draft.unreadable', { ns: 'agent' }) })
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
    // 创作类型跟着这个会话走，发出去一条不该把它弹回图片。
    if (this.snapshot.draft === draft) {
      this.update({ ...EMPTY_DRAFT, ...(draft.mode ? { mode: draft.mode } : {}) })
    }
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
        this.publish({ error: i18next.t('draft.saveFailed', { ns: 'agent' }) })
      }
    })
    return this.writes
  }
}

/** 冲的是此刻还活着的那些：被 `removeProjectDraft` 摘掉的不在其中，也就不会被写回去。 */
function flushSessions() {
  for (const session of sessions.values()) void session.flush()
}

export function agentDraft(
  conversationId: string | null,
  projectId?: string,
  legacyDraft = false,
): DraftSession {
  const legacyKey = scopedStorageName(`agent-draft:${conversationId ?? 'new'}`)
  const key = projectId ? scopedStorageName(`agent-project-draft:${projectId}`) : legacyKey
  let session = sessions.get(key)
  if (!session) {
    // 草稿的存活周期早就与输入框无关，冲盘也不该绑在它的挂载上。同一个函数登记多次只算一次。
    flushOnPageHide(flushSessions)
    session = new DraftSession(
      key,
      projectId && (conversationId || legacyDraft) ? legacyKey : undefined,
    )
    sessions.set(key, session)
  }
  return session
}

/** 首条消息创建会话时沿用同一份草稿，避免上传中的输入突然切到空草稿。 */
export function bindNewAgentDraft(conversationId: string, projectId?: string): void {
  if (projectId) return
  const oldKey = scopedStorageName('agent-draft:new')
  const session = sessions.get(oldKey)
  if (!session) return
  const key = scopedStorageName(`agent-draft:${conversationId}`)
  session.moveTo(key)
  sessions.set(key, session)
  sessions.delete(oldKey)
}

export async function removeProjectDraft(
  projectId: string,
  conversationId: string | null,
): Promise<void> {
  const key = scopedStorageName(`agent-project-draft:${projectId}`)
  const legacyKey = conversationId ? scopedStorageName(`agent-draft:${conversationId}`) : null
  const session = sessions.get(key)
  if (session) await session.flush()
  const db = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('drafts', 'readwrite')
    tx.objectStore('drafts').delete(key)
    if (legacyKey) tx.objectStore('drafts').delete(legacyKey)
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error)
    tx.onerror = () => reject(tx.error)
  })
  sessions.delete(key)
}
