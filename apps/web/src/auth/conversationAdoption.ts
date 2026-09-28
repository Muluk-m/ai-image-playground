/**
 * 登录后的设备会话认领在后台跑。仅当历史读取返回 404/403 时才等待认领并重试，
 * 避免已属于当前用户的会话被慢认领请求阻塞。
 */
const WAIT_MS = 15_000
let tracked: Promise<boolean> | null = null
let uncertain = false
let pending = false

export function trackConversationAdoption(request: Promise<unknown>): void {
  uncertain = false
  pending = true
  const trackedRequest = request.then(
    () => {
      if (tracked === trackedRequest) {
        uncertain = false
        pending = false
      }
      return true
    },
    () => {
      if (tracked === trackedRequest) {
        uncertain = true
        pending = false
      }
      return false
    },
  )
  tracked = trackedRequest
}

export function isConversationAdoptionPending(): boolean {
  return pending
}

export async function waitForConversationAdoption(): Promise<boolean> {
  const pending = tracked
  if (!pending) return true
  if (uncertain) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const confirmed = await Promise.race([
      pending,
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), WAIT_MS)
      }),
    ])
    if (!confirmed && tracked === pending) uncertain = true
    return confirmed
  } finally {
    clearTimeout(timer)
  }
}
