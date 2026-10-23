import { getDeviceId } from '../../../lib/deviceId'

const KEY = 'canvas-uploader-tab'
const CHANNEL = 'canvas-uploader-tab'
const TAB = /^[\w-]{1,32}$/
/** 沿用存着的后缀前，等这么久看有没有同后缀的页面回应（同源标签页之间的消息一般几毫秒就到）。 */
export const CANVAS_UPLOADER_PROBE_MS = 150

interface Announce {
  type: 'hello' | 'here'
  tab: string
  nonce: string
  born: number
}

let tab: string | undefined
let channel: BroadcastChannel | undefined
let nonce: string | undefined
let born = 0
/** 定下来之后后缀不再换：之后撞上的都是更晚启动的页面，由它们换。 */
let settled = false
let settledPromise: Promise<void> | undefined

function randomId(): string {
  // 运行时调用（不在模块加载时），boot/polyfills 已经装好；连 randomUUID 都没有时退回 Math.random。
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

function isAnnounce(value: unknown): value is Announce {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    (v.type === 'hello' || v.type === 'here') &&
    typeof v.tab === 'string' &&
    typeof v.nonce === 'string' &&
    typeof v.born === 'number'
  )
}

function announce(type: Announce['type']) {
  if (!tab || !nonce) return
  try {
    channel?.postMessage({ type, tab, nonce, born } satisfies Announce)
  } catch {}
}

/**
 * 「复制标签页」会把 sessionStorage 一起复制，新页拿到和原页一样的后缀。沿用存着的后缀时先在同源的
 * BroadcastChannel 上报一下，等一小会儿：撞上同一后缀的另一个页面时，后启动的那个换一个新后缀
 * （同一毫秒启动分不出先后时两边都换），先启动的回一声让对方知道撞了。刷新本页时原来的页面已经没了，
 * 没人回应，后缀保持不变。等待结束就定下来，之后不再换，在途上传的声明始终用同一个 ID。
 * 没有 BroadcastChannel 的环境确认不了唯一性，不沿用存着的后缀，每次加载都换新的。
 */
function start() {
  nonce = randomId()
  born = Date.now()
  let stored: string | null = null
  try {
    stored = sessionStorage.getItem(KEY)
  } catch {}
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      channel = new BroadcastChannel(CHANNEL)
    } catch {
      channel = undefined
    }
  }
  if (!channel || !stored || !TAB.test(stored)) {
    tab = freshTab()
    settled = true
    settledPromise = Promise.resolve()
  } else {
    tab = stored
    settledPromise = new Promise((resolve) =>
      setTimeout(() => {
        settled = true
        resolve()
      }, CANVAS_UPLOADER_PROBE_MS),
    )
  }
  if (!channel) return
  channel.onmessage = (event: MessageEvent) => {
    const other = event.data
    if (!isAnnounce(other) || other.nonce === nonce || other.tab !== tab) return
    // 先用撞上的后缀回一声，让对方也知道撞了（同时启动时对方也要换）。
    if (other.type === 'hello') announce('here')
    if (!settled && born >= other.born) {
      tab = freshTab()
      announce('hello')
    }
  }
  announce('hello')
}

function currentTab(): string {
  if (!tab) start()
  return tab as string
}

/**
 * 写上传声明用的「上传者」：设备 ID 再加本标签页的随机后缀。同一浏览器的另一个标签页内存里没有这张原图，
 * 要把它当成别处在传。后缀存在 sessionStorage 里：刷新本标签页后仍认得自己写的声明，接着传；
 * 存不了（隐私模式等）时退回只在内存里。复制出来的标签页通过 BroadcastChannel 发现撞号后换新后缀。
 */
export function getCanvasUploaderId(): string {
  return `${getDeviceId()}:${currentTab()}`
}

/** 上传者 ID 定下来（不会再因撞号而换）时 resolve；写上传声明之前要等它。 */
export function canvasUploaderSettled(): Promise<void> {
  currentTab()
  return settledPromise as Promise<void>
}

// 页面一加载就开始确认后缀，打开画布时通常早已定下来。
if (typeof window !== 'undefined') currentTab()
