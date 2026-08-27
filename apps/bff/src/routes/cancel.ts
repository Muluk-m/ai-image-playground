import { Elysia, t } from 'elysia'
import { pixelStore, taskStore } from '../db/client'
import { transcodeInputBlobsToWebp } from '../lib/blobStore'
import { log } from '../lib/logger'

/**
 * PUT /v1/queue/requests/:id/cancel
 *
 * 流程：
 * 1. 分两次 atomic UPDATE 到 'cancelled'（先 queued 再 in_progress），命中的那次告诉我们
 *    任务是否已经起跑；两次都没命中时回 SELECT 一次决定返 404 还是当前终态
 * 2. 独立 worker 的 scheduler 轮询到 cancelled 后触发 AbortController；
 *    API 和 worker 不共享内存，数据库状态是取消信号的单一事实源
 * 3. worker catch AbortError 后 UPDATE 'failed' 因 WHERE status='in_progress'
 *    不匹配自然 no-op，不会反悔覆盖 'cancelled'
 */
export const cancelRoutes = new Elysia().put(
  '/v1/queue/requests/:id/cancel',
  async ({ params, status }) => {
    // 还在队列里的任务没人读过原图，可以立刻归档成 WebP。已经 in_progress 的不能：
    // worker 已把原图读入内存后才调上游，竞态下会把 WebP 存档误当原图送进模型——
    // 交给 worker 观察 cancel/abort 后自己转码，进程中断时 startup recovery 补做。
    const cancelledFromQueue = await taskStore.cancelFrom(params.id, 'queued')
    if (cancelledFromQueue) await transcodeInputBlobsToWebp(params.id, pixelStore)

    if (cancelledFromQueue || (await taskStore.cancelFrom(params.id, 'in_progress'))) {
      log.info({ event: 'task.cancel_requested', taskId: params.id }, 'task cancelled')
      return { request_id: params.id, status: 'cancelled' as const }
    }

    const existing = await taskStore.getById(params.id)

    if (!existing) return status(404, { error: 'task_not_found' })
    return { request_id: existing.id, status: existing.status }
  },
  { params: t.Object({ id: t.String() }) },
)
