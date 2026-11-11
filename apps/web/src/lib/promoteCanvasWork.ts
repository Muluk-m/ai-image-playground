import type { CanvasResult, GenerationDetail } from '@image-playground/shared'
import { authenticatedBffFetch } from './authClient'
import { accountScope, scopedStorageName } from './authScope'
import { refreshPlatformGeneration } from './platformGenerations'
import { bffBaseUrl } from './runtimeConfig'

/** 作品页在打开时会自己重读；已经打开时靠这个事件把新入选的画布图算进页签。 */
export const canvasWorkPromotedEvent = 'canvas-work-promoted'

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PENDING_KEY = 'aip.canvas-promote-pending'
const inflight = new Set<string>()
const settled = new Set<string>()

function pendingKeys(storageKey = scopedStorageName(PENDING_KEY)): string[] {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(storageKey) ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
  } catch {
    return []
  }
}

function rememberPending(storageKey: string, key: string) {
  try {
    const keys = pendingKeys(storageKey)
    if (!keys.includes(key)) sessionStorage.setItem(storageKey, JSON.stringify([...keys, key]))
  } catch {
    // 隐私模式写不了会话存储时，这一页里的重试仍然有效。
  }
}

function forgetPending(storageKey: string, key: string) {
  try {
    sessionStorage.setItem(
      storageKey,
      JSON.stringify(pendingKeys(storageKey).filter((item) => item !== key)),
    )
  } catch {
    // 同上。
  }
}

/** 节点结果被选成主图时调用。不是队列图、或没有平台任务号时什么都不做。 */
export function promoteChosenCanvasResult(result: CanvasResult | undefined): void {
  if (!result || result.kind !== 'image' || result.source.type !== 'queue') return
  promoteCanvasQueueOutput(result.source.taskId, result.source.outputIndex)
}

/** 把队列里这一张收进作品。过期、不是本人的任务都不重试；网络失败会再试两次。 */
export function promoteCanvasQueueOutput(taskId: string, outputIndex: number): void {
  if (!TASK_ID.test(taskId) || !Number.isInteger(outputIndex) || outputIndex < 0) return
  const key = `${taskId}:${outputIndex}`
  if (settled.has(key) || inflight.has(key)) return
  const stillThisAccount = accountScope()
  const storageKey = scopedStorageName(PENDING_KEY)
  inflight.add(key)
  rememberPending(storageKey, key)
  void attempt(taskId, outputIndex, 0, stillThisAccount).then((done) => {
    inflight.delete(key)
    if (!stillThisAccount()) return
    if (done) {
      settled.add(key)
      forgetPending(storageKey, key)
    }
  })
}

/** 账号范围已经定下来之后再补提升。待办按账号分开存，不会拿上一个账号的任务去打当前会话。 */
export function resumePendingCanvasPromotes(): void {
  for (const key of pendingKeys()) {
    const cut = key.lastIndexOf(':')
    const taskId = key.slice(0, cut)
    const outputIndex = Number(key.slice(cut + 1))
    if (cut <= 0 || !Number.isInteger(outputIndex)) continue
    promoteCanvasQueueOutput(taskId, outputIndex)
  }
}

async function attempt(
  taskId: string,
  outputIndex: number,
  tryIndex: number,
  stillThisAccount: () => boolean,
): Promise<boolean> {
  try {
    const response = await authenticatedBffFetch(
      `${bffBaseUrl()}/api/generations/${encodeURIComponent(taskId)}/promote`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outputIndex }),
      },
    )
    if (!stillThisAccount()) return true
    // 过期、任务不存在或参数不对都不会因为再试而成功。401 留到下次打开再试。
    if (response.status === 409 || response.status === 404 || response.status === 400) return true
    if (response.ok) {
      const detail = (await response.json()) as GenerationDetail
      if (!stillThisAccount()) return true
      if (!detail?.id || !Array.isArray(detail.outputs) || detail.outputs.length === 0) return false
      await refreshPlatformGeneration(detail)
      if (!stillThisAccount()) return true
      if (typeof window !== 'undefined') window.dispatchEvent(new Event(canvasWorkPromotedEvent))
      return true
    }
    if (response.status === 401) return false
    throw new Error('promote_failed')
  } catch {
    if (!stillThisAccount() || tryIndex >= 2) return !stillThisAccount()
    await new Promise((resolve) => setTimeout(resolve, 1000 * (tryIndex + 1)))
    return attempt(taskId, outputIndex, tryIndex + 1, stillThisAccount)
  }
}
