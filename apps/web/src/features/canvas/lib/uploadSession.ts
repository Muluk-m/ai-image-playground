import { getDeviceId } from '../../../lib/deviceId'

const KEY = 'canvas-uploader-tab'
const LOCK = 'canvas-uploader-tab:'
const TAB = /^[\w-]{1,32}$/
/**
 * 沿用存着的后缀时，最多等这么久拿它的锁：刷新本页时旧页面的锁在卸载后才放，稍等一下就能拿到；
 * 复制出来的标签页等不到（原页一直持有），超时后换新后缀。
 */
export const CANVAS_UPLOADER_LOCK_WAIT_MS = 1000

let tab: string | undefined
let settledPromise: Promise<void> | undefined

function randomId(): string {
  // 运行时调用（不在模块加载时）；连 randomUUID 都没有时退回 Math.random。
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
  }
}

function freshTab(): string {
  const next = randomId()
    .replace(/[^\w-]/g, '')
    .slice(0, 8)
  try {
    sessionStorage.setItem(KEY, next)
  } catch {}
  return next
}

/** 拿到 name 的锁就一直持有到页面关闭，返回是否拿到；waitMs 为 0 时拿不到立即返回。 */
function holdLock(locks: LockManager, name: string, waitMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const forever = () => {
      resolve(true)
      return new Promise<never>(() => {})
    }
    const giveUp = () => resolve(false)
    if (waitMs <= 0) {
      locks
        .request(name, { ifAvailable: true }, (lock) => (lock ? forever() : giveUp()))
        .catch(giveUp)
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), waitMs)
    locks
      .request(name, { signal: controller.signal }, () => {
        clearTimeout(timer)
        return forever()
      })
      .catch(giveUp)
  })
}

/**
 * 「复制标签页」会把 sessionStorage 一起复制，新页拿到和原页一样的后缀。用 Web Locks 保证同一时刻
 * 一个后缀只属于一个页面：每个页面一直持有自己后缀的锁。沿用存着的后缀时先拿它的锁（拿锁是原子的，
 * 两个页面不可能同时拿到）：刷新本页时旧页面卸载后锁就放了，能拿到，后缀不变；复制出来的页拿不到，
 * 换一个新后缀。拿到锁之后后缀就定下来，不再换。不支持 Web Locks 的环境确认不了唯一性，
 * 不沿用存着的后缀，每次加载都换新的。
 */
function start() {
  let stored: string | null = null
  try {
    stored = sessionStorage.getItem(KEY)
  } catch {}
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks || typeof locks.request !== 'function') {
    tab = freshTab()
    settledPromise = Promise.resolve()
    return
  }
  tab = stored && TAB.test(stored) ? stored : freshTab()
  const reused = tab === stored
  settledPromise = (async () => {
    if (await holdLock(locks, LOCK + tab, reused ? CANVAS_UPLOADER_LOCK_WAIT_MS : 0)) return
    // 别的页面正持有这个后缀：换新后缀再拿，随机后缀撞上的概率可以忽略，拿不到也照用。
    tab = freshTab()
    await holdLock(locks, LOCK + tab, 0)
  })()
}

function currentTab(): string {
  if (!tab) start()
  return tab as string
}

/**
 * 写上传声明用的「上传者」：设备 ID 再加本标签页的随机后缀。同一浏览器的另一个标签页内存里没有这张原图，
 * 要把它当成别处在传。后缀存在 sessionStorage 里：刷新本标签页后仍认得自己写的声明，接着传；
 * 存不了（隐私模式等）时退回只在内存里。复制出来的标签页靠 Web Locks 发现撞号后换新后缀。
 * 写声明之前要等 canvasUploaderSettled()，之前读到的后缀可能还会换。
 */
export function getCanvasUploaderId(): string {
  return `${getDeviceId()}:${currentTab()}`
}

/** 上传者 ID 定下来（本页已持有这个后缀的锁，不会再换）时 resolve；写上传声明之前要等它。 */
export function canvasUploaderSettled(): Promise<void> {
  currentTab()
  return settledPromise as Promise<void>
}

// 页面一加载就开始确认后缀，打开画布时通常早已定下来。
if (typeof window !== 'undefined') currentTab()
