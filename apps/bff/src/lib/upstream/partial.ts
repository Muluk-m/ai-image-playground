import type { PartialImageFailure, TaskErrorType } from '@image-playground/shared'
import { isObject } from '../type-guards'
import { UpstreamResultUnknownError, UpstreamTimeoutError } from './errors'
import type { UpstreamCallResult } from './shared'

/** 一张没出来的失败分类，口径同 task-runner 给整单失败定的 `error_type`。 */
function failureType(reason: unknown): TaskErrorType {
  if (reason instanceof UpstreamTimeoutError) return 'upstream_timeout'
  if (reason instanceof UpstreamResultUnknownError) return 'upstream_result_unknown'
  if (isObject(reason) && reason.upstreamStatus === 429) return 'rate_limited'
  return 'upstream_error'
}

/** 合并好的部分结果上记下缺口：要几张、几张没出、为什么。 */
export function withPartialFailure(
  result: UpstreamCallResult,
  requested: number,
  failures: readonly unknown[],
): UpstreamCallResult {
  const record: PartialImageFailure = {
    requested,
    failed: failures.length,
    type: failureType(failures[0]),
  }
  return {
    ...result,
    payload: { ...(result.payload as Record<string, unknown>), partial_failure: record },
  }
}

/** 结果里记下的缺口；整单都出了图的结果没有。 */
export function partialFailureOf(payload: unknown): PartialImageFailure | undefined {
  const record = isObject(payload) ? payload.partial_failure : undefined
  if (!isObject(record)) return undefined
  const { requested, failed, type } = record
  if (typeof requested !== 'number' || typeof failed !== 'number' || typeof type !== 'string')
    return undefined
  return { requested, failed, type: type as TaskErrorType }
}

/** 结果接口带出缺口的那个字段；没有缺口就什么都不加。 */
export function partialFailureField(payload: unknown): { partial_failure?: PartialImageFailure } {
  const partial = partialFailureOf(payload)
  return partial ? { partial_failure: partial } : {}
}
