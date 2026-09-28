/**
 * 登录后的设备会话认领可以在后台跑，但读旧会话历史前要给它一个完成机会。
 * 等待最多 15 秒；超时或失败时仍可读用户已有的会话，只是不准把 404 当作旧会话已删除。
 */
const WAIT_MS = 15_000
let tracked: Promise<boolean> | null = null
let uncertain = false

export function trackConversationAdoption(request: Promise<unknown>): void {
  uncertain = false
  const pending = request.then(
    () => {
      if (tracked === pending) uncertain = false
      return true
    },
    () => {
      if (tracked === pending) uncertain = true
      return false
    },
  )
  tracked = pending
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
