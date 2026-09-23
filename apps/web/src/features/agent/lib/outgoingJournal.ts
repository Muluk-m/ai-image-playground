import type { AgentMode, AgentTurnReference } from '@image-playground/shared'
import { scopedStorageName } from '../../../lib/authScope'

/**
 * 一条已经交出去、但还没被服务端收下的用户消息。
 *
 * 发出去到服务端应答之间有几秒网络；这段时间里刷新或断网，消息只在内存里就没了——用户看见
 * 标题已经改成这句话，对话却是空的。所以起轮之前先把它落到本机：回来时照样看得到，
 * 并且能拿同一个 `clientMessageId` 原样重发（服务端按它去重，不会排两次、不会重复扣费）。
 */
export interface OutgoingMessage {
  /** 同时是 `clientMessageId`：服务端认的就是它。 */
  readonly id: string
  /** 归属的项目；会话可能还没建出来，所以本机按项目存。 */
  readonly projectId: string
  readonly conversationId: string | null
  readonly text: string
  readonly references: readonly AgentTurnReference[]
  readonly mode: AgentMode
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

async function readRaw(projectId: string): Promise<OutgoingMessage[]> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(key(projectId))
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : [])
    request.onerror = () => reject(request.error)
  })
}

async function write(projectId: string, messages: readonly OutgoingMessage[]): Promise<void> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite')
    const store = transaction.objectStore(STORE)
    if (messages.length) store.put([...messages], key(projectId))
    else store.delete(key(projectId))
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
    transaction.onerror = () => reject(transaction.error)
  })
}

/** 读不出来就当没有：本机存储坏了不该把这一轮拦在门外。 */
export async function outgoingMessages(projectId: string): Promise<OutgoingMessage[]> {
  try {
    return await readRaw(projectId)
  } catch {
    return []
  }
}

/**
 * 起轮**之前**落一条。这一步要等它写完：写在飞行途中，刷新就可能抢在写入之前。
 * 写失败不拦发送——存不下只是回不来，比发不出去轻。
 */
export async function rememberOutgoing(message: OutgoingMessage): Promise<void> {
  try {
    const kept = (await outgoingMessages(message.projectId)).filter((one) => one.id !== message.id)
    await write(message.projectId, [...kept, message])
  } catch {
    /* 存不下就只是刷新后回不来。 */
  }
}

/** 会话是发送途中现建的：补上它，重发时才知道往哪个会话发。 */
export async function bindOutgoingConversation(
  projectId: string,
  id: string,
  conversationId: string,
): Promise<void> {
  try {
    const messages = await outgoingMessages(projectId)
    if (!messages.some((one) => one.id === id)) return
    await write(
      projectId,
      messages.map((one) => (one.id === id ? { ...one, conversationId } : one)),
    )
  } catch {
    /* 同上。 */
  }
}

/** 服务端收下了，或者这句话已经退回输入框：本机这份就不必再留。 */
export async function forgetOutgoing(projectId: string, id: string): Promise<void> {
  try {
    const messages = await outgoingMessages(projectId)
    if (!messages.some((one) => one.id === id)) return
    await write(
      projectId,
      messages.filter((one) => one.id !== id),
    )
  } catch {
    /* 同上。 */
  }
}
