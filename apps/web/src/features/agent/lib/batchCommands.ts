import { scopedStorageName } from '../../../lib/authScope'
import { bffBaseUrl } from '../../../lib/runtimeConfig'
import { type AgentBatchCommand, AgentRequestError, executeBatchCommand } from './agentClient'

const DATABASE = 'image-playground-agent-batch-commands'
const STORE = 'commands'
let database: Promise<IDBDatabase> | undefined

function openDatabase(): Promise<IDBDatabase> {
  if (!database) {
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    void database.catch(() => {
      database = undefined
    })
  }
  return database
}

function storageKey(batchId: string): string {
  return scopedStorageName(`agent-batch-command:${bffBaseUrl()}:${batchId}`)
}

/** One immutable operation per account/backend/batch, committed before any control POST. */
export function batchCommands(batchId: string) {
  const key = storageKey(batchId)
  const current = () => key === storageKey(batchId)
  const assertCurrent = () => {
    if (!current()) throw new Error('Batch command scope changed')
  }
  async function update(change: (command: AgentBatchCommand | null) => AgentBatchCommand | null) {
    const db = await openDatabase()
    return new Promise<AgentBatchCommand | null>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite')
      const store = transaction.objectStore(STORE)
      const request = store.get(key)
      let result: AgentBatchCommand | null = null
      request.onsuccess = () => {
        result = change(request.result ?? null)
        if (result) store.put(result, key)
        else store.delete(key)
      }
      transaction.oncomplete = () => resolve(result)
      transaction.onabort = () => reject(transaction.error)
      transaction.onerror = () => reject(transaction.error)
    })
  }
  async function read(): Promise<AgentBatchCommand | null> {
    const db = await openDatabase()
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get(key)
      request.onsuccess = () => resolve(request.result ?? null)
      request.onerror = () => reject(request.error)
    })
  }
  async function execute(proposed: AgentBatchCommand) {
    assertCurrent()
    // Two cards/tabs may race: the transaction preserves the first operation's identity.
    const command = (await update((existing) => existing ?? proposed))!
    assertCurrent()
    const clear = () =>
      update((existing) => (existing?.commandId === command.commandId ? null : existing))
    try {
      const page = await executeBatchCommand(batchId, command)
      await clear()
      assertCurrent()
      return page
    } catch (error) {
      // A lost response or a server failure is not evidence that the command was rejected.
      if (error instanceof AgentRequestError && [400, 404, 409, 422].includes(error.status))
        await clear()
      throw error
    }
  }
  return { current, read, execute }
}
