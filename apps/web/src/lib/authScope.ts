import type { StateStorage } from 'zustand/middleware'

const ANONYMOUS_SCOPE = 'anonymous'
let currentScope = ANONYMOUS_SCOPE

/**
 * 必须在首次加载 App/store/db 之前设置。认证部署按用户隔离本地历史、图片与 BYOK
 * 配置；匿名部署保留旧 key/DB 名，做到无迁移兼容。
 */
export function setClientStorageScope(userId: string | null): void {
  currentScope = userId ? `user-${userId.replace(/[^a-zA-Z0-9_-]/g, '_')}` : ANONYMOUS_SCOPE
}

export function scopedStorageName(baseName: string): string {
  return currentScope === ANONYMOUS_SCOPE ? baseName : `${baseName}:${currentScope}`
}

export const scopedLocalStorage: StateStorage = {
  getItem(name) {
    try {
      return globalThis.localStorage?.getItem(scopedStorageName(name)) ?? null
    } catch {
      return null
    }
  },
  setItem(name, value) {
    try {
      globalThis.localStorage?.setItem(scopedStorageName(name), value)
    } catch {
      // 隐私模式或存储已满时保持内存态，跟 Zustand 默认 fallback 一致。
    }
  },
  removeItem(name) {
    try {
      globalThis.localStorage?.removeItem(scopedStorageName(name))
    } catch {
      // best effort
    }
  },
}
