import {
  type AsyncTaskProtocol,
  asyncTaskFailure,
  imageTaskProtocol,
  isRecoverablePollFailure,
  warnIfAsyncTasksDisabled,
} from './async-tasks'
import {
  UpstreamPartialResultError,
  UpstreamResultUnknownError,
  UpstreamTimeoutError,
} from './errors'
import { withPartialFailure } from './partial'
import type { UpstreamCallResult } from './shared'
import { abortableSleep, asyncPollDelayMs, type UpstreamTransportSession } from './transport'
import type { UpstreamCallParams, UpstreamFetchInit } from './types'

/**
 * 一次逻辑调用拆成 count 条单张请求再合并。部分出图时不让整单失败：交付已出的那几张，结果里
 * 记下缺口（{@link withPartialFailure}），task-runner 按交付张数结算、其余退回。一张都没出照原样
 * 抛第一条失败；被取消（用户取消、租约丢了）照原样抛，不交付。
 * 结果待核查的线路（`reconciliationRequired`）保留整组语义：哪条算没算钱要人核对，不能先交付；
 * 其它线路只要有一条结果未知（可能已出图），也照这个口径整组待核查，不按部分交付退款。
 */
export async function fanOutRequests(
  requestedCount: number | undefined,
  run: () => Promise<UpstreamCallResult>,
  merge: (results: UpstreamCallResult[]) => UpstreamCallResult,
  reconciliationRequired = false,
  cancelled: () => boolean = () => false,
): Promise<UpstreamCallResult> {
  const count = Math.max(1, requestedCount ?? 1)
  if (count === 1) return run()
  if (reconciliationRequired)
    return merge(await collectFanOutResults(Array.from({ length: count }, run), true))
  const settled = await Promise.allSettled(Array.from({ length: count }, run))
  const delivered = settled.flatMap((one) => (one.status === 'fulfilled' ? [one.value] : []))
  const failures = settled.flatMap((one) => (one.status === 'rejected' ? [one.reason] : []))
  if (failures.length === 0) return merge(delivered)
  // 结果未知的那条可能已经出了图、上游也可能已经计费：不能当“没出图”退钱再交付，
  // 照结果待核查线路的口径整组交给核查，免得错退积分、重试时重复出图。
  const unknown = failures.find((reason) => reason instanceof UpstreamResultUnknownError)
  // 显式要求核查：task-runner 只在任务已标记或错误带 requiresReconciliation 时才进核查。
  // 被取消时照原样抛，不改成核查。
  if (unknown && delivered.length > 0 && !cancelled())
    throw new UpstreamResultUnknownError('部分请求已完成，整组结果和结算待核查。', {
      cause: unknown,
      requiresReconciliation: true,
    })
  if (delivered.length === 0 || cancelled()) throw unknown ?? failures[0]
  return withPartialFailure(merge(delivered), count, failures)
}

export function fanOutFailure<T>(settled: PromiseSettledResult<T>[], preserveUnknown = false) {
  const failures = settled.filter((one): one is PromiseRejectedResult => one.status === 'rejected')
  return (
    (preserveUnknown
      ? failures.find((one) => one.reason instanceof UpstreamResultUnknownError)
      : undefined) ?? failures[0]
  )
}

export async function collectFanOutResults<T>(
  requests: Promise<T>[],
  preserveUnknown = false,
): Promise<T[]> {
  if (!preserveUnknown) return Promise.all(requests)
  const settled = await Promise.allSettled(requests)
  const failure = fanOutFailure(settled, preserveUnknown)
  if (failure && settled.some((one) => one.status === 'fulfilled')) {
    throw new UpstreamResultUnknownError('部分请求已完成，整组结果和结算待核查。', {
      cause: failure.reason,
    })
  }
  if (failure) throw failure.reason
  return settled.flatMap((one) => (one.status === 'fulfilled' ? [one.value] : []))
}

export interface AsyncTaskRunner {
  collectTaskIds(
    protocol: AsyncTaskProtocol,
    count: number,
    makeInit: () => UpstreamFetchInit,
  ): Promise<string[]>
  pollAsyncTask(protocol: AsyncTaskProtocol, taskId: string): Promise<UpstreamCallResult>
  dispatch(
    base: string,
    url: string,
    count: number,
    useAsyncTasks: boolean,
    makeInit: () => UpstreamFetchInit,
    merge: (results: UpstreamCallResult[]) => UpstreamCallResult,
  ): Promise<UpstreamCallResult>
}

export function createAsyncTaskRunner(
  session: UpstreamTransportSession,
  params: UpstreamCallParams,
  authHeader: Record<string, string>,
): AsyncTaskRunner {
  const resumeIds = params.resume?.taskIds ?? []

  /**
   * 补齐到 count 个上游任务：已有 id 原样带出，只为缺口发提交请求。上游没有幂等键，
   * 重提已落库的 id 就是第二次计费，所以缺口是唯一可以提交的份额。
   */
  const collectTaskIds = async (
    protocol: AsyncTaskProtocol,
    count: number,
    makeInit: () => UpstreamFetchInit,
  ): Promise<string[]> => {
    const missing = count - resumeIds.length
    if (missing <= 0) return [...resumeIds]
    if (session.finalLookup || params.resume?.pollOnly) return [...resumeIds]
    const acceptedIds: (string | undefined)[] = Array.from({ length: missing })
    const settled = await Promise.allSettled(
      Array.from({ length: missing }, async (_, index) => {
        const response = await session.performFetch(protocol.submitUrl, makeInit())
        const taskId = protocol.readTaskId((await session.parseResponse(response)).payload)
        // Acceptance is evidence even when its per-dispatch database write fails.
        acceptedIds[index] = taskId
        const dispatchId = session.dispatchIdentityOf(response)
        if (dispatchId) await params.onUpstreamTaskId?.(dispatchId, taskId)
        return taskId
      }),
    )
    const accepted = acceptedIds.flatMap((id) => (id ? [id] : []))
    const taskIds = [...resumeIds, ...accepted]
    // Attempt the aggregate checkpoint even if a per-dispatch write rejected.
    if (accepted.length) {
      try {
        await params.onUpstreamTaskIds?.(taskIds)
      } catch (error) {
        throw new UpstreamResultUnknownError('上游已受理任务，但任务编号保存失败，结果待核查。', {
          cause: error,
          requiresReconciliation: true,
        })
      }
    }
    const failure = fanOutFailure(settled, params.reconciliationRequired)
    if (failure) {
      warnIfAsyncTasksDisabled(failure.reason)
      if (taskIds.length > 0) {
        const detail =
          failure.reason instanceof Error ? failure.reason.message.slice(0, 200) : '提交失败'
        throw new UpstreamResultUnknownError(
          `部分提交被拒绝，已受理任务的最终结果待核查：${detail}`,
          { cause: failure.reason, requiresReconciliation: true },
        )
      }
      throw failure.reason
    }
    return taskIds
  }

  /** 硬超时会 abort 掉轮询的 sleep；不映射的话裸 AbortError 会被当成用户取消，行没有终态。 */
  const pollDelay = async (attempt: number): Promise<void> => {
    try {
      await abortableSleep(asyncPollDelayMs(attempt), session.deadline.signal)
    } catch (err) {
      if (session.deadline.timedOut) throw new UpstreamTimeoutError()
      throw err
    }
  }

  /** 轮询单个上游任务到终态。判定与提交侧方向相反：瞬时错误一律继续轮。 */
  const pollAsyncTask = async (
    protocol: AsyncTaskProtocol,
    taskId: string,
  ): Promise<UpstreamCallResult> => {
    const pollUrl = protocol.pollUrl(taskId)
    for (let attempt = 0; ; attempt++) {
      if (Date.now() >= session.deadlineAt && !(session.finalLookup && attempt === 0))
        throw new UpstreamTimeoutError()
      let payload: unknown
      try {
        payload = (
          await session.parseResponse(
            await session.performFetch(pollUrl, { method: 'GET', headers: authHeader }, false),
          )
        ).payload
      } catch (err) {
        if (
          session.deadline.timedOut ||
          session.externalSignal?.aborted ||
          !isRecoverablePollFailure(err)
        )
          throw err
        // 留 payload 为 undefined，下面按 pending 走同一条退避路径。
      }
      const state = protocol.readState(payload)
      if (state.kind === 'completed') return { payload: state.payload }
      if (state.kind === 'failed') throw asyncTaskFailure(state.status, payload)
      if (session.finalLookup) throw new UpstreamTimeoutError()
      await pollDelay(attempt)
    }
  }

  /**
   * 一次逻辑调用 → count 个上游请求 → 合并。同步模式直接发；异步模式提交后转轮询。
   * count 是上游请求数，不是产图数；原生 n 只派发一次，其余路径逐图 fan-out。
   * 恢复时保留已派发数量，避免新路由掩盖旧任务缺失的提交结果。
   */
  const dispatch = async (
    base: string,
    url: string,
    count: number,
    useAsyncTasks: boolean,
    makeInit: () => UpstreamFetchInit,
    merge: (results: UpstreamCallResult[]) => UpstreamCallResult,
  ): Promise<UpstreamCallResult> => {
    if (!useAsyncTasks) {
      return fanOutRequests(
        count,
        async () => session.parseResponse(await session.performFetch(url, makeInit())),
        merge,
        params.reconciliationRequired,
        session.cancelled,
      )
    }
    const protocol = imageTaskProtocol(base, url)
    // 已提交任务只恢复当时的调用数，不能按新路由补发或误判旧原生批次。
    const expectedCount = params.resume?.invocationCount ?? count
    const taskIds = await collectTaskIds(protocol, expectedCount, makeInit)
    const results = await collectFanOutResults(
      taskIds.map((id) => pollAsyncTask(protocol, id)),
      params.reconciliationRequired,
    )
    const result = results.length === 1 ? results[0]! : merge(results)
    if (taskIds.length < expectedCount) throw new UpstreamPartialResultError(result.payload)
    return result
  }

  return { collectTaskIds, pollAsyncTask, dispatch }
}
