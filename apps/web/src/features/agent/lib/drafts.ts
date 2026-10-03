import type { AgentReturnedQueuedMessage } from '@image-playground/shared'
import { i18next } from '../../../i18n'
import { accountScope, scopedStorageName } from '../../../lib/authScope'
import { getAttachmentLimits } from '../../../lib/clientCapabilities'
import { flushOnPageHide } from '../../../lib/flushOnPageHide'
import {
  attachmentSourceOwner,
  recoverLocalAttachmentSources,
  registerLocalAttachmentSource,
} from '../../../lib/localAttachmentSources'
import { peekCanvasWorkspace } from '../../canvas/lib/activeProject'
import { attachmentUploadsEnabled, canReuseAttachmentMedia } from './attachmentUploads'
import { returnQueuedToDraft } from './messageQueue'
import { outgoingCommandIds } from './outgoingJournal'
import { type AgentDraft, EMPTY_DRAFT, hasDraftContent } from './references'
import type { UnsentTurnSubmission } from './turnSubmission'

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

/** Migrate all copies of one command together, keeping exact originals shared by immutable handle. */
function normalizeSources<T>(value: T): T {
  const limits = attachmentUploadsEnabled() ? getAttachmentLimits() : undefined
  if (!limits) return value
  const originals = new Map<string, string>()
  const workspace = peekCanvasWorkspace()
  const knownMedia = new Map(
    Object.entries(workspace?.doc.files ?? {}).flatMap(([fileId, source]) => {
      const id = workspace?.cloud?.knownMediaId(fileId, source)
      return id ? [[source, id] as const] : []
    }),
  )
  const walk = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      const next = input.map(walk)
      return next.some((one, index) => one !== input[index]) ? next : input
    }
    if (!input || typeof input !== 'object') return input
    let changed = false
    const next = Object.fromEntries(
      Object.entries(input).map(([key, child]) => {
        let replacement = child
        if (
          (key === 'dataUrl' || key === 'maskDataUrl') &&
          typeof child === 'string' &&
          child.startsWith('data:image/')
        ) {
          const knownId =
            key === 'dataUrl' && canReuseAttachmentMedia(input as { dataUrl: string })
              ? knownMedia.get(child)
              : undefined
          if (knownId) replacement = `aip-media:${knownId}`
          else {
            replacement =
              originals.get(child) ?? registerLocalAttachmentSource(child, limits.imageBytes)
            originals.set(child, replacement as string)
          }
        } else if (['references', 'submission', 'unsent', 'remainingUnsent'].includes(key))
          replacement = walk(child)
        if (replacement !== child) changed = true
        return [key, replacement]
      }),
    )
    return changed ? next : input
  }
  return walk(value) as T
}

/** 创作类型跟着输入框此刻的选择走：搁在一边的那份不该把用户刚切的类型改回去。 */
function withMode(draft: AgentDraft, mode: AgentDraft['mode']): AgentDraft {
  const { mode: _ignored, ...rest } = draft
  return mode ? { ...rest, mode } : rest
}

type StoredDraft = AgentDraft & {
  unsent?: AgentDraft
  remainingUnsent?: AgentDraft[]
  returnedQueueIds?: string[]
}

function draftObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validDraftReference(value: unknown, submitted = false): boolean {
  if (!draftObject(value)) return false
  if (typeof value[submitted ? 'imageId' : 'id'] !== 'string') return false
  if (
    submitted
      ? typeof value.dataUrl !== 'string' && typeof value.mediaId !== 'string'
      : typeof value.dataUrl !== 'string'
  )
    return false
  for (const key of ['name', 'maskDataUrl', 'maskMediaId'])
    if (value[key] !== undefined && typeof value[key] !== 'string') return false
  if (value.origin !== undefined && value.origin !== 'selection') return false
  if (
    value.editAction !== undefined &&
    !['inpaint', 'erase', 'crop', 'outpaint'].includes(String(value.editAction))
  )
    return false
  return (
    value.regions === undefined ||
    (Array.isArray(value.regions) &&
      value.regions.every(
        (region) =>
          draftObject(region) &&
          ['x', 'y', 'width', 'height'].every(
            (key) => typeof region[key] === 'number' && Number.isFinite(region[key]),
          ),
      ))
  )
}

function validDraft(value: unknown): value is AgentDraft {
  if (
    !draftObject(value) ||
    typeof value.prompt !== 'string' ||
    !Array.isArray(value.references) ||
    !value.references.every((reference) => validDraftReference(reference))
  )
    return false
  if (value.mode !== undefined && value.mode !== 'image' && value.mode !== 'video') return false
  if (value.submission === undefined) return true
  const submission = value.submission
  return (
    draftObject(submission) &&
    typeof submission.id === 'string' &&
    typeof submission.text === 'string' &&
    (submission.mode === 'image' || submission.mode === 'video') &&
    typeof submission.clarificationAnswer === 'boolean' &&
    Array.isArray(submission.references) &&
    submission.references.every((reference) => validDraftReference(reference, true)) &&
    (submission.params === undefined || draftObject(submission.params)) &&
    (submission.canvas === undefined || draftObject(submission.canvas)) &&
    (submission.canvasReferenceIds === undefined ||
      (Array.isArray(submission.canvasReferenceIds) &&
        submission.canvasReferenceIds.every((id) => typeof id === 'string')))
  )
}

function validStoredDraft(value: unknown): value is StoredDraft {
  if (!validDraft(value)) return false
  const row = value as StoredDraft
  return (
    (row.unsent === undefined || validDraft(row.unsent)) &&
    (row.remainingUnsent === undefined ||
      (Array.isArray(row.remainingUnsent) && row.remainingUnsent.every(validDraft))) &&
    (row.returnedQueueIds === undefined ||
      (Array.isArray(row.returnedQueueIds) &&
        row.returnedQueueIds.every((id) => typeof id === 'string')))
  )
}

export interface DraftSnapshot {
  readonly draft: AgentDraft
  readonly loading: boolean
  readonly recoveryBlocked: boolean
  readonly submitting: boolean
  readonly error: string | null
  /**
   * 上次没发出去、这次读回来的那份草稿。它先不进输入框，由用户选恢复还是丢弃；
   * 决定之前照旧留在存储里，不会因为这次没理它就丢了。
   */
  readonly unsent: AgentDraft | null
  readonly recoverable: boolean
}

/** 草稿独立于输入框的挂载周期；每个账号、会话各保留一份。 */
export class DraftSession {
  private snapshot: DraftSnapshot = {
    draft: EMPTY_DRAFT,
    loading: true,
    recoveryBlocked: false,
    submitting: false,
    error: null,
    unsent: null,
    recoverable: false,
  }
  private listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private writes: Promise<void> = Promise.resolve()
  private revision = 0
  private savedRevision = 0
  private submission = 0
  private previousKey: string | undefined
  private remainingUnsent: AgentDraft[] = []
  private returnedQueueIds = new Set<string>()

  private readonly currentAccount = accountScope()
  private sourceOwner: ReturnType<typeof attachmentSourceOwner>
  readonly ready: Promise<void>

  constructor(
    public key: string,
    private fallbackKey?: string,
    private projectId?: string,
  ) {
    this.sourceOwner = attachmentSourceOwner(`draft:${key}`)
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

  private restoreContents(stored: StoredDraft) {
    const { unsent, remainingUnsent = [], returnedQueueIds: _receipts, ...draft } = stored
    this.remainingUnsent = remainingUnsent
    // Unsent content remains separate until the user explicitly restores it.
    if (unsent || hasDraftContent(draft))
      this.publish({
        draft: { ...EMPTY_DRAFT, ...(stored.mode ? { mode: stored.mode } : {}) },
        unsent: unsent ?? draft,
        recoverable: Boolean(unsent || draft.submission),
        ...(unsent ? { draft } : {}),
      })
    else this.publish({ draft, unsent: null, recoverable: false })
  }

  private mergeRestored(stored: StoredDraft) {
    if (this.revision === 0) {
      this.restoreContents(stored)
      return
    }
    const { unsent, remainingUnsent = [], returnedQueueIds: _receipts, ...draft } = stored
    const local = [this.snapshot.draft, this.snapshot.unsent, ...this.remainingUnsent].filter(
      (one): one is AgentDraft => Boolean(one),
    )
    const pending = [this.snapshot.unsent, ...this.remainingUnsent].filter(
      (one): one is AgentDraft => Boolean(one),
    )
    for (const candidate of [draft, unsent, ...remainingUnsent]) {
      if (!candidate || !hasDraftContent(candidate)) continue
      if (
        local.some(
          (one) =>
            (candidate.submission && candidate.submission.id === one.submission?.id) ||
            JSON.stringify(one) === JSON.stringify(candidate),
        )
      )
        continue
      pending.push(candidate)
      local.push(candidate)
    }
    this.remainingUnsent = pending.slice(1)
    this.publish({ unsent: pending[0] ?? null, recoverable: pending.length > 0 })
  }

  private async preserveInvalidDraft(key: string, raw: unknown) {
    // Only explicit recovery creates a copy; it remains owned by this draft's deletion lifecycle.
    const recoveryKey = `invalid:${crypto.randomUUID()}:${this.key}`
    const owner = attachmentSourceOwner(`draft:${recoveryKey}`)
    const originalOwner = attachmentSourceOwner(`draft:${key}`)
    let archived = false
    await owner
      .withDocument(async () => {
        await owner.retain(raw)
        const db = await openDatabase()
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('drafts', 'readwrite')
          const store = tx.objectStore('drafts')
          const request = store.get(key)
          request.onsuccess = () => {
            if (JSON.stringify(request.result) !== JSON.stringify(raw)) {
              tx.abort()
              return
            }
            store.put(raw, recoveryKey)
            store.delete(key)
          }
          tx.oncomplete = () => {
            archived = true
            resolve()
          }
          tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('draft_changed'))
        })
        await originalOwner.release()
      })
      .catch(async (error: unknown) => {
        if (!archived) await owner.release().catch(() => {})
        throw error
      })
  }

  private async restore(explicitRecovery = false) {
    let stored: unknown
    let readKey = this.previousKey ?? this.key
    try {
      await recoverLocalAttachmentSources().catch(() => {})
      const db = await openDatabase()
      stored = await new Promise<unknown>((resolve, reject) => {
        const request = db.transaction('drafts').objectStore('drafts').get(readKey)
        request.onsuccess = () => {
          if (request.result !== undefined || !this.fallbackKey) {
            resolve(request.result)
            return
          }
          readKey = this.fallbackKey
          const fallback = db.transaction('drafts').objectStore('drafts').get(readKey)
          fallback.onsuccess = () => resolve(fallback.result)
          fallback.onerror = () => reject(fallback.error)
        }
        request.onerror = () => reject(request.error)
      })
      if (!this.currentAccount()) return
      if (stored !== undefined && !validStoredDraft(stored)) {
        if (!explicitRecovery) throw new Error('invalid_draft')
        await this.preserveInvalidDraft(readKey, stored)
        stored = undefined
      }
      let normalized: StoredDraft = validStoredDraft(stored) ? stored : EMPTY_DRAFT
      if (this.projectId) {
        const journaled = await outgoingCommandIds(this.projectId)
        if (!this.currentAccount()) return
        const { unsent, remainingUnsent = [], ...draft } = normalized
        const owned = (one: AgentDraft) =>
          Boolean(one.submission && journaled.has(one.submission.id))
        const queued = [unsent, ...remainingUnsent].filter((one): one is AgentDraft => Boolean(one))
        const retained = queued.filter((one) => !owned(one))
        if (owned(draft) || retained.length !== queued.length)
          normalized = {
            ...(owned(draft)
              ? { ...EMPTY_DRAFT, ...(draft.mode ? { mode: draft.mode } : {}) }
              : draft),
            ...(retained[0] ? { unsent: retained[0], remainingUnsent: retained.slice(1) } : {}),
            returnedQueueIds: normalized.returnedQueueIds,
          }
        // A returned command may have arrived while the initial journal read was still pending.
        const local = this.snapshot.draft
        const localQueued = [this.snapshot.unsent, ...this.remainingUnsent].filter(
          (one): one is AgentDraft => Boolean(one),
        )
        const localRetained = localQueued.filter((one) => !owned(one))
        if (owned(local) || localRetained.length !== localQueued.length) {
          this.remainingUnsent = localRetained.slice(1)
          this.revision += 1
          this.publish({
            draft: owned(local)
              ? { ...EMPTY_DRAFT, ...(local.mode ? { mode: local.mode } : {}) }
              : local,
            unsent: localRetained[0] ?? null,
            recoverable: localRetained.length > 0,
          })
        }
      }
      for (const id of normalized.returnedQueueIds ?? []) this.returnedQueueIds.add(id)
      normalized = normalizeSources(normalized)
      this.mergeRestored(normalized)
      this.publish({ recoveryBlocked: false, error: null })
      if (stored !== undefined && normalized !== stored) this.revision += 1
    } catch {
      if (validStoredDraft(stored) && this.revision === 0) this.restoreContents(stored)
      this.publish({ recoveryBlocked: true, error: i18next.t('draft.unreadable', { ns: 'agent' }) })
    } finally {
      this.publish({ loading: false })
      if (!this.snapshot.recoveryBlocked && this.currentAccount()) await this.flush()
    }
  }

  retryRecovery = async () => {
    if (!this.snapshot.recoveryBlocked || this.snapshot.loading || !this.currentAccount()) return
    this.publish({ loading: true })
    await this.restore(true)
  }

  async returnQueued(returned: readonly AgentReturnedQueuedMessage[]): Promise<boolean> {
    await this.ready
    if (this.snapshot.loading || this.snapshot.recoveryBlocked || !this.currentAccount())
      return false
    const fresh = returned.filter((one) => !this.returnedQueueIds.has(one.id))
    if (fresh.length) {
      if (!this.update((draft) => returnQueuedToDraft(draft, fresh))) return false
      if (this.snapshot.unsent) this.publish({ recoverable: true })
      for (const one of fresh) this.returnedQueueIds.add(one.id)
    }
    await this.flush()
    return this.snapshot.error === null && this.currentAccount()
  }

  update = (change: AgentDraft | ((draft: AgentDraft) => AgentDraft)) => {
    if (this.snapshot.recoveryBlocked || !this.currentAccount()) return false
    let draft = typeof change === 'function' ? change(this.snapshot.draft) : change
    if (this.currentAccount()) draft = normalizeSources(draft)
    const previous = this.snapshot.draft
    if (
      draft.submission &&
      draft.submission === previous.submission &&
      (draft.prompt !== previous.prompt ||
        JSON.stringify(draft.references) !== JSON.stringify(previous.references))
    ) {
      const { submission: _previousSubmission, ...edited } = draft
      draft = edited
    }
    if (draft === this.snapshot.draft) return true
    this.revision += 1
    this.publish({ draft })
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.flush()
    }, 300)
    return true
  }

  /** 发送失败时接回原消息；新输入保留，失败消息进待恢复区。落盘失败不确认交接。 */
  async returnUnsent(draft: AgentDraft): Promise<boolean> {
    if (this.snapshot.recoveryBlocked) return false
    const current = this.snapshot.draft
    if (!current.prompt.trim() && current.references.length === 0) {
      if (this.snapshot.unsent) this.publish({ recoverable: true })
      this.update(draft)
    } else {
      if (this.snapshot.unsent) this.remainingUnsent.push(draft)
      this.revision += 1
      this.publish({ unsent: this.snapshot.unsent ?? draft, recoverable: true })
    }
    await this.flush()
    return !this.snapshot.loading && this.snapshot.error === null
  }

  /** Persist the immutable command identity before it can coexist with an outgoing journal. */
  async stageSubmission(original: AgentDraft, submission: UnsentTurnSubmission): Promise<void> {
    const staged = { ...original, submission }
    if (this.snapshot.draft === original) {
      this.update(staged)
      await this.flush()
    } else {
      await this.returnUnsent(staged)
    }
    if (this.snapshot.error) throw new Error('attachment_draft_save_failed')
  }

  /** Remove only the draft copy whose identical command has become durable elsewhere. */
  async acceptSubmission(id: string): Promise<boolean> {
    if (this.snapshot.recoveryBlocked) return false
    const { draft, unsent } = this.snapshot
    const current = draft.submission?.id === id
    const queued = [unsent, ...this.remainingUnsent].filter((one): one is AgentDraft =>
      Boolean(one),
    )
    const remaining = queued.filter((one) => one.submission?.id !== id)
    if (!current && remaining.length === queued.length) {
      await this.flush()
      return this.snapshot.error === null
    }
    this.remainingUnsent = remaining.slice(1)
    this.revision += 1
    this.publish({
      draft: current ? { ...EMPTY_DRAFT, ...(draft.mode ? { mode: draft.mode } : {}) } : draft,
      unsent: remaining[0] ?? null,
      recoverable: Boolean(
        remaining[0] && (this.snapshot.recoverable || unsent?.submission?.id === id),
      ),
    })
    await this.flush()
    return this.snapshot.error === null
  }

  /** 把没发出去的那份放回输入框；输入框里此刻跟着选区带进来的图保留。 */
  restoreUnsent = () => {
    if (this.snapshot.recoveryBlocked) return
    const unsent = this.snapshot.unsent
    if (!unsent) return
    const current = this.snapshot.draft
    // 恢复入口也能在正在写字时使用；把当前这句排在待恢复区末尾，避免互相覆盖。
    const keepCurrent = this.snapshot.recoverable && hasDraftContent(current)
    if (keepCurrent) this.remainingUnsent.push(current)
    const kept = (keepCurrent ? [] : current.references).filter(
      (one) => one.origin === 'selection' && !unsent.references.some((old) => old.id === one.id),
    )
    const next = this.remainingUnsent.shift() ?? null
    this.publish({ unsent: next, recoverable: Boolean(next) })
    this.update(
      withMode(
        {
          ...unsent,
          references: [...unsent.references, ...kept],
          submission: kept.length ? undefined : unsent.submission,
        },
        this.snapshot.draft.mode,
      ),
    )
  }

  /** 丢掉没发出去的那份：存储里换成输入框此刻的内容。 */
  discardUnsent = () => {
    if (this.snapshot.recoveryBlocked) return
    if (!this.snapshot.unsent) return
    const next = this.remainingUnsent.shift() ?? null
    this.publish({ unsent: next, recoverable: Boolean(next) })
    this.revision += 1
    void this.flush()
  }

  moveTo(key: string) {
    this.previousKey = this.key
    this.key = key
    this.sourceOwner = attachmentSourceOwner(`draft:${key}`)
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
    if (this.snapshot.loading || this.snapshot.recoveryBlocked) return this.writes
    if (this.revision === this.savedRevision) return this.writes
    const revision = this.revision
    // 用户还没决定恢复或丢弃时，输入框空着不能把那份没发出去的覆盖掉。
    const { draft: current, unsent } = this.snapshot
    const contents =
      unsent && this.snapshot.recoverable
        ? { ...current, unsent, remainingUnsent: [...this.remainingUnsent] }
        : unsent && !hasDraftContent(current)
          ? withMode(unsent, current.mode)
          : current
    const draft = { ...contents, returnedQueueIds: [...this.returnedQueueIds] }
    const key = this.key
    const previousKey = this.previousKey
    const sourceOwner = this.sourceOwner
    const previousSourceOwner = previousKey
      ? attachmentSourceOwner(`draft:${previousKey}`)
      : undefined
    this.writes = this.writes.then(async () => {
      try {
        await sourceOwner.withDocument(async () => {
          await sourceOwner.retain(draft)
          const db = await openDatabase()
          await new Promise<void>((resolve, reject) => {
            const transaction = db.transaction('drafts', 'readwrite')
            transaction.objectStore('drafts').put(draft, key)
            if (previousKey) transaction.objectStore('drafts').delete(previousKey)
            transaction.oncomplete = () => resolve()
            transaction.onabort = () => reject(transaction.error)
            transaction.onerror = () => reject(transaction.error)
          })
          await sourceOwner.replace(draft)
          await previousSourceOwner?.release()
          this.savedRevision = Math.max(this.savedRevision, revision)
          if (this.previousKey === previousKey) this.previousKey = undefined
          this.publish({ error: null })
        })
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
    // 登记在这里而不是输入框里：草稿活得比它久。同一个函数登记多次只算一次。
    flushOnPageHide(flushSessions)
    session = new DraftSession(
      key,
      projectId && (conversationId || legacyDraft) ? legacyKey : undefined,
      projectId,
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
  const sourceOwner = attachmentSourceOwner(`draft:${key}`)
  const legacySourceOwner = legacyKey ? attachmentSourceOwner(`draft:${legacyKey}`) : undefined
  const session = sessions.get(key)
  if (session) await session.flush()
  await sourceOwner.withDocument(async () => {
    const db = await openDatabase()
    const recoveryKeys: string[] = []
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite')
      const cursor = tx.objectStore('drafts').openCursor()
      cursor.onsuccess = () => {
        const row = cursor.result
        if (!row) return
        const storedKey = String(row.key)
        if (
          storedKey.startsWith('invalid:') &&
          [key, legacyKey].some((one) => one && storedKey.endsWith(`:${one}`))
        ) {
          recoveryKeys.push(storedKey)
          row.delete()
        }
        row.continue()
      }
      tx.objectStore('drafts').delete(key)
      if (legacyKey) tx.objectStore('drafts').delete(legacyKey)
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error)
      tx.onerror = () => reject(tx.error)
    })
    await sourceOwner.release()
    await legacySourceOwner?.release()
    for (const recoveryKey of recoveryKeys)
      await attachmentSourceOwner(`draft:${recoveryKey}`).release()
  })
  sessions.delete(key)
}
