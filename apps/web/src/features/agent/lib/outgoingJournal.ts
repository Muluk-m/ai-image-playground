import type { AgentMode } from '@image-playground/shared'
import { accountScope, scopedStorageName } from '../../../lib/authScope'
import {
  attachmentSourceOwner,
  hasLocalAttachmentSources,
} from '../../../lib/localAttachmentSources'
import type { TurnSubmissionSnapshot } from './turnSubmission'

/**
 * 一条已经交出去、但还没被服务端收下的用户消息。
 *
 * 发出去到服务端应答之间有几秒网络；这段时间里刷新或断网，消息只在内存里就没了——用户看见
 * 标题已经改成这句话，对话却是空的。所以起轮之前先把它落到本机：回来时照样看得到，
 * 并且能拿同一个 `clientMessageId` 原样重发（服务端按它去重，不会排两次、不会重复扣费）。
 */
export interface OutgoingMessage extends TurnSubmissionSnapshot {
  /** 同时是 `clientMessageId`：服务端认的就是它。 */
  readonly id: string
  /** 归属的项目；会话可能还没建出来，所以本机按项目存。 */
  readonly projectId: string
  readonly conversationId: string | null
  readonly text: string
  readonly mode: AgentMode
  /** 画布快捷编辑校验遮罩时选定的模型，恢复发送必须沿用。 */
  readonly modelOverride?: string
  readonly clarificationAnswer: boolean
  readonly createdAt: number
}

const DB_NAME = 'image-playground-agent-outgoing'
const STORE = 'outgoing'
let database: Promise<IDBDatabase> | undefined
// apps/web 的 lib target 还没到 es2024，这里用不了 `Promise.withResolvers`（同 heroHandoff.ts）。
function openDatabase(): Promise<IDBDatabase> {
  if (!database) {
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    database = opening
    opening.catch(() => {
      database = undefined
    })
  }
  return database
}

/** 按账号分隔：换账号之后不该看见上一个账号没发出去的话。 */
const key = (projectId: string) => scopedStorageName(`agent-outgoing:${projectId}`)

async function readRaw(storageKey: string): Promise<OutgoingMessage[]> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(storageKey)
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : [])
    request.onerror = () => reject(request.error)
  })
}

async function update(
  storageKey: string,
  change: (messages: OutgoingMessage[]) => readonly OutgoingMessage[],
): Promise<readonly OutgoingMessage[]> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite')
    const store = transaction.objectStore(STORE)
    const request = store.get(storageKey)
    let changed: readonly OutgoingMessage[] = []
    request.onsuccess = () => {
      const messages = change(Array.isArray(request.result) ? request.result : [])
      changed = messages
      if (messages.length) store.put([...messages], storageKey)
      else store.delete(storageKey)
    }
    transaction.oncomplete = () => resolve(changed)
    transaction.onabort = () => reject(transaction.error)
    transaction.onerror = () => reject(transaction.error)
  })
}

/** 读不出来就当没有：本机存储坏了不该把这一轮拦在门外。 */
export async function outgoingMessages(projectId: string): Promise<OutgoingMessage[]> {
  try {
    return await readRaw(key(projectId))
  } catch {
    return []
  }
}

/** Draft recovery must distinguish an empty journal from storage that could not be read. */
export async function outgoingCommandIds(projectId: string): Promise<ReadonlySet<string>> {
  return new Set((await readRaw(key(projectId))).map((message) => message.id))
}

/**
 * 起轮**之前**落一条。这一步要等它写完：写在飞行途中，刷新就可能抢在写入之前。
 * 持久原件的发送命令必须先保存成功；旧内联输入保留原有尽力保存行为。
 */
export async function rememberOutgoing(message: OutgoingMessage): Promise<void> {
  const storageKey = key(message.projectId)
  const current = accountScope()
  const owner = attachmentSourceOwner(`outgoing:${storageKey}:${message.id}`)
  await owner.withDocument(async () => {
    try {
      await owner.retain(message)
      if (!current()) throw new Error('media_scope_changed')
      await update(storageKey, (messages) => [
        ...messages.filter((one) => one.id !== message.id),
        message,
      ])
      // A failed cleanup can retain extra bytes, but must not turn a committed command into a new draft.
      await owner.replace(message).catch(() => {})
    } catch (error) {
      if (hasLocalAttachmentSources(message)) {
        const persisted = await readRaw(storageKey).catch(() => undefined)
        if (persisted)
          await owner.replace(persisted.find((one) => one.id === message.id)).catch(() => {})
        throw error
      }
      /* 旧内联输入存不下时保留原有行为。 */
    }
  })
}

/** 会话是发送途中现建的：补上它，重发时才知道往哪个会话发。 */
export async function bindOutgoingConversation(
  projectId: string,
  id: string,
  conversationId: string,
): Promise<void> {
  try {
    await update(key(projectId), (messages) =>
      messages.map((one) => (one.id === id ? { ...one, conversationId } : one)),
    )
  } catch {
    /* 同上。 */
  }
}

/** 服务端收下了，或者这句话已经退回输入框：本机这份就不必再留。 */
export async function forgetOutgoing(projectId: string, id: string): Promise<void> {
  const storageKey = key(projectId)
  const owner = attachmentSourceOwner(`outgoing:${storageKey}:${id}`)
  await owner.withDocument(async () => {
    try {
      await update(storageKey, (messages) => messages.filter((one) => one.id !== id))
      await owner.release()
    } catch {
      /* 同上。 */
    }
  })
}

/** 只更新仍未被确认的原记录；取消或成功移除后，迟到的上传不得复活它。 */
export async function updateOutgoingInput(
  projectId: string,
  id: string,
  input: TurnSubmissionSnapshot,
): Promise<void> {
  const storageKey = key(projectId)
  const sameAccount = accountScope()
  const owner = attachmentSourceOwner(`outgoing:${storageKey}:${id}`)
  await owner.withDocument(async () => {
    try {
      await owner.retain(input)
      if (!sameAccount()) return
      const current = await update(storageKey, (messages) =>
        messages.map((one) => (one.id === id ? { ...one, ...input } : one)),
      )
      await owner.replace(current.find((one) => one.id === id))
    } catch {
      /* 存不下就保留之前的原始输入。 */
    }
  })
}
