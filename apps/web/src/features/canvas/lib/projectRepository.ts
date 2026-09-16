import type { CloudProjectSummary } from '@image-playground/shared'
import { scopedStorageName } from '../../../lib/authScope'
import { openCanvasDatabase } from './persistence'

export interface CanvasProject {
  readonly id: string
  readonly name: string
  readonly customName: boolean
  readonly conversationId: string | null
  readonly sceneKey: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly hasContent: boolean
  readonly cover?: string
  readonly cloud?: { revision: number; nameDirty?: boolean }
}

const prefix = () => `${scopedStorageName('canvas-project')}:project:`
const key = (id: string) => `${prefix()}${id}`

/** 元数据与场景共用数据库，删除在同一事务中完成；不复制原图到项目索引。 */
export const projectRepository = {
  async list(): Promise<CanvasProject[]> {
    const start = prefix()
    const db = await openCanvasDatabase()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('scene', 'readonly')
      const request = transaction
        .objectStore('scene')
        .getAll(IDBKeyRange.bound(start, `${start}\uffff`))
      transaction.oncomplete = () => resolve(request.result)
      transaction.onabort = () => reject(transaction.error)
      transaction.onerror = () => reject(transaction.error)
    })
  },

  async legacyScenes(): Promise<{ sceneKey: string; conversationId: string | null }[]> {
    const start = `${scopedStorageName('canvas')}:`
    const db = await openCanvasDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('scene', 'readonly')
      const request = tx.objectStore('scene').getAllKeys(IDBKeyRange.bound(start, `${start}\uffff`))
      tx.oncomplete = () =>
        resolve(
          request.result.flatMap<{ sceneKey: string; conversationId: string | null }>((key) => {
            if (typeof key !== 'string') return []
            const suffix = key.slice(start.length)
            if (suffix === 'draft') return [{ sceneKey: key, conversationId: null }]
            if (suffix.startsWith('conversation:')) {
              try {
                return [
                  {
                    sceneKey: key,
                    conversationId: decodeURIComponent(suffix.slice('conversation:'.length)),
                  },
                ]
              } catch {
                return []
              }
            }
            return []
          }),
        )
      tx.onabort = () => reject(tx.error)
      tx.onerror = () => reject(tx.error)
    })
  },

  async create(
    name = '未命名项目',
    legacy?: { sceneKey: string; conversationId: string | null },
    cloud = false,
  ): Promise<CanvasProject> {
    const id = legacy ? `legacy:${legacy.sceneKey}` : crypto.randomUUID()
    const now = Date.now()
    const project: CanvasProject = {
      id,
      name,
      customName: name !== '未命名项目',
      conversationId: legacy?.conversationId ?? null,
      sceneKey: legacy?.sceneKey ?? `${scopedStorageName('canvas')}:project:${id}`,
      createdAt: now,
      updatedAt: now,
      hasContent: Boolean(legacy?.conversationId),
      ...(cloud ? { cloud: { revision: 0 } } : {}),
    }
    const storageKey = key(id)
    const db = await openCanvasDatabase()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('scene', 'readwrite')
      const store = transaction.objectStore('scene')
      let result = project
      const existing = store.get(storageKey)
      existing.onsuccess = () => {
        if (existing.result) result = existing.result
        else store.add(project, storageKey)
      }
      transaction.oncomplete = () => resolve(result)
      transaction.onabort = () => reject(transaction.error)
      transaction.onerror = () => reject(transaction.error)
    })
  },

  async importCloud(summary: CloudProjectSummary): Promise<CanvasProject> {
    const storageKey = key(summary.id)
    const scope = scopedStorageName('canvas')
    const db = await openCanvasDatabase()
    return new Promise((resolve, reject) => {
      const tx = db.transaction('scene', 'readwrite')
      const store = tx.objectStore('scene')
      const request = store.get(storageKey)
      let result: CanvasProject
      request.onsuccess = () => {
        // 列表不能覆盖本机尚未同步的名称或文档；打开项目时再核对修订。
        result = request.result ?? {
          id: summary.id,
          name: summary.name,
          customName: true,
          conversationId: null,
          sceneKey: `${scope}:project:${summary.id}`,
          createdAt: summary.createdAt,
          updatedAt: summary.updatedAt,
          hasContent: summary.elementCount > 0,
          cloud: { revision: summary.revision },
        }
        if (!request.result) store.add(result, storageKey)
      }
      tx.oncomplete = () => resolve(result)
      tx.onabort = () => reject(tx.error)
      tx.onerror = () => reject(tx.error)
    })
  },

  async update(
    id: string,
    patch: Partial<
      Pick<
        CanvasProject,
        'name' | 'customName' | 'conversationId' | 'updatedAt' | 'hasContent' | 'cover' | 'cloud'
      >
    >,
  ): Promise<CanvasProject> {
    const storageKey = key(id)
    const db = await openCanvasDatabase()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('scene', 'readwrite')
      const store = transaction.objectStore('scene')
      const request = store.get(storageKey)
      let result: CanvasProject
      request.onsuccess = () => {
        if (!request.result) {
          transaction.abort()
          return
        }
        result = { ...request.result, ...patch }
        store.put(result, storageKey)
      }
      transaction.oncomplete = () => resolve(result)
      transaction.onabort = () => reject(transaction.error ?? new Error('Project not found'))
      transaction.onerror = () => reject(transaction.error)
    })
  },

  async remove(id: string): Promise<void> {
    const storageKey = key(id)
    const db = await openCanvasDatabase()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('scene', 'readwrite')
      const store = transaction.objectStore('scene')
      const request = store.get(storageKey)
      request.onsuccess = () => {
        if (request.result) store.delete((request.result as CanvasProject).sceneKey)
        store.delete(storageKey)
      }
      transaction.oncomplete = () => resolve()
      transaction.onabort = () => reject(transaction.error)
      transaction.onerror = () => reject(transaction.error)
    })
  },
}
