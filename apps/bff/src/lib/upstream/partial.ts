import type { PartialImageFailure, TaskErrorType } from '@image-playground/shared'
import { isObject } from '../type-guards'
import { UpstreamResultUnknownError, UpstreamTimeoutError } from './errors'
import type { UpstreamCallResult } from './shared'

/** {@link failureType} 会写进缺口记录的几种分类；读回时只认这几种。 */
const PARTIAL_FAILURE_TYPES: ReadonlySet<string> = new Set<TaskErrorType>([
  'upstream_timeout',
  'upstream_result_unknown',
  'rate_limited',
  'upstream_error',
])

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

/**
 * 结果里记下的缺口；整单都出了图的结果没有。这条记录既回给客户端又决定结算张数，
 * 读回时要求张数是非负整数、缺的不多于要的、分类是写入时会用的那几种，否则当没有缺口。
 */
export function partialFailureOf(payload: unknown): PartialImageFailure | undefined {
  const record = isObject(payload) ? payload.partial_failure : undefined
  if (!isObject(record)) return undefined
  const { requested, failed, type } = record
  if (
    !Number.isSafeInteger(requested) ||
    !Number.isSafeInteger(failed) ||
    (failed as number) < 0 ||
    (failed as number) > (requested as number) ||
    typeof type !== 'string' ||
    !PARTIAL_FAILURE_TYPES.has(type)
  )
    return undefined
  return { requested: requested as number, failed: failed as number, type: type as TaskErrorType }
}

/** 结果接口带出缺口的那个字段；没有缺口就什么都不加。 */
export function partialFailureField(payload: unknown): { partial_failure?: PartialImageFailure } {
  const partial = partialFailureOf(payload)
  return partial ? { partial_failure: partial } : {}
}
