/**
 * 短 TTL in-memory LRU cache。给反代图片端点用：单 task n=4 张图会触发 4 次
 * /image?idx=N，每次都 SELECT 一次 tasks 浪费；缓存 (provider, model) 30s。
 */

interface Entry<V> {
  value: V | null
  expiresAt: number
}

export interface TaskMetaCacheOptions<V> {
  maxEntries: number
  ttlMs: number
  load: (taskId: string) => Promise<V | null>
}

export interface TaskMetaCache<V> {
  get(taskId: string): Promise<V | null>
}

export function createTaskMetaCache<V>(opts: TaskMetaCacheOptions<V>): TaskMetaCache<V> {
  const entries = new Map<string, Entry<V>>()

  function touch(key: string, entry: Entry<V>) {
    entries.delete(key)
    entries.set(key, entry)
    while (entries.size > opts.maxEntries) {
      const oldest = entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      entries.delete(oldest)
    }
  }

  return {
    async get(taskId) {
      const now = Date.now()
      const cached = entries.get(taskId)
      if (cached && cached.expiresAt > now) {
        touch(taskId, cached) // refresh LRU position
        return cached.value
      }
      const value = await opts.load(taskId)
      touch(taskId, { value, expiresAt: now + opts.ttlMs })
      return value
    },
  }
}
