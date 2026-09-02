import type { StateStorage } from 'zustand/middleware'

const ANONYMOUS_SCOPE = 'anonymous'
let currentScope = ANONYMOUS_SCOPE

/** store persist 的 name。 */
export const STORE_PERSIST_KEY = 'image-playground'

/**
 * 走 scopedLocalStorage 的全部 key。登录后认领匿名历史要照着它搬，
 * 新增按 scope 隔离的 key 必须登记进来。
 */
export const SCOPED_LOCAL_STORAGE_KEYS = [STORE_PERSIST_KEY]

/**
 * 必须在首次加载 App/store/db 之前设置。认证部署按用户隔离本地历史、图片与 BYOK
 * 配置；匿名部署保留旧 key/DB 名，做到无迁移兼容。
 */
export function setClientStorageScope(userId: string | null): void {
  // 用 encodeURIComponent 而不是字符替换：替换是有损的，`a/b` 与 `a_b` 会映射到
  // 同一个命名空间，两个账号就会共用 localStorage 设置、IndexedDB 图片与 BYOK
  // 配置。当前 id 是服务端 randomUUID，撞不上，但编码是单射的，不留这个坑。
  currentScope = userId ? `user-${encodeURIComponent(userId)}` : ANONYMOUS_SCOPE
}

export function scopedStorageName(baseName: string): string {
  return currentScope === ANONYMOUS_SCOPE ? baseName : `${baseName}:${currentScope}`
}

interface SyncStorage {
  getItem(name: string): string | null
  setItem(name: string, value: string): void
  removeItem(name: string): void
}

/** 隐私模式、存储已满、被策略禁用时 localStorage 的每次访问都可能抛，一律吞掉退到内存态。 */
export const safeLocalStorage: SyncStorage = {
  getItem(name) {
    try {
      return globalThis.localStorage?.getItem(name) ?? null
    } catch {
      return null
    }
  },
  setItem(name, value) {
    try {
      globalThis.localStorage?.setItem(name, value)
    } catch {
      // best effort
    }
  },
  removeItem(name) {
    try {
      globalThis.localStorage?.removeItem(name)
    } catch {
      // best effort
    }
  },
}

export const scopedLocalStorage: StateStorage = {
  getItem: (name) => safeLocalStorage.getItem(scopedStorageName(name)),
  setItem: (name, value) => safeLocalStorage.setItem(scopedStorageName(name), value),
  removeItem: (name) => safeLocalStorage.removeItem(scopedStorageName(name)),
}
