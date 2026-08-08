import type { StateStorage } from 'zustand/middleware'

const ANONYMOUS_SCOPE = 'anonymous'
let currentScope = ANONYMOUS_SCOPE

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
