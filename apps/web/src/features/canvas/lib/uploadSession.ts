import { getDeviceId } from '../../../lib/deviceId'

const KEY = 'canvas-uploader-tab'
const CHANNEL = 'canvas-uploader-tab'
const TAB = /^[\w-]{1,32}$/

interface Announce {
  type: 'hello' | 'here'
  tab: string
  nonce: string
  born: number
}

let tab: string | undefined
let channel: BroadcastChannel | undefined
const nonce = crypto.randomUUID()
const born = Date.now()

function freshTab(): string {
  const next = crypto.randomUUID().slice(0, 8)
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
  if (!tab) return
  try {
    channel?.postMessage({ type, tab, nonce, born } satisfies Announce)
  } catch {}
}

/**
 * 「复制标签页」会把 sessionStorage 一起复制，新页拿到和原页一样的后缀。每个页面启动时在同源的
 * BroadcastChannel 上报一下自己的后缀；撞上同一后缀的另一个页面时，后启动的那个（同时启动的按 nonce 定）
 * 换一个新后缀（同时启动的两边都换），先启动的回一声让对方知道撞了。刷新本页时原来的页面已经没了，没人回应，后缀保持不变。
 */
function watchCollisions() {
  if (channel || typeof BroadcastChannel === 'undefined') return
  try {
    channel = new BroadcastChannel(CHANNEL)
  } catch {
    return
  }
  channel.onmessage = (event: MessageEvent) => {
    const other = event.data
    if (!isAnnounce(other) || other.nonce === nonce || other.tab !== tab) return
    // 同一毫秒启动分不出谁是原页，两边都换：宁可都不认旧声明，也不让复制页冒认原页的上传。
    const lose = born >= other.born
    // 先用撞上的后缀回一声，让对方也知道撞了（同时启动时对方也要换）。
    if (other.type === 'hello') announce('here')
    if (lose) {
      tab = freshTab()
      announce('hello')
    }
  }
  announce('hello')
}

function currentTab(): string {
  if (!tab) {
    let stored: string | null = null
    try {
      stored = sessionStorage.getItem(KEY)
    } catch {}
    tab = stored && TAB.test(stored) ? stored : freshTab()
    watchCollisions()
  }
  return tab
}

/**
 * 写上传声明用的「上传者」：设备 ID 再加本标签页的随机后缀。同一浏览器的另一个标签页内存里没有这张原图，
 * 要把它当成别处在传。后缀存在 sessionStorage 里：刷新本标签页后仍认得自己写的声明，接着传；
 * 存不了（隐私模式等）时退回只在内存里。复制出来的标签页通过 BroadcastChannel 发现撞号后换新后缀。
 */
export function getCanvasUploaderId(): string {
  return `${getDeviceId()}:${currentTab()}`
}

// 页面一加载就上报后缀，尽早发现复制标签页撞号，不等第一次上传。
if (typeof window !== 'undefined') currentTab()
