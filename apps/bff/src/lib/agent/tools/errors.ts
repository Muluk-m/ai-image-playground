import type { AgentToolErrorCode, TaskErrorType } from '@image-playground/shared'
import type { CreateQueueTaskOutcome } from '../../taskSubmission'

/**
 * 带分类的工具失败。消息照旧是给模型读的那句话；`code` 是给界面的——界面只认它（ADR 0006）。
 * pi 接住工具抛的错时只留下文字（`createErrorToolResult`），所以分类要在 pi 之外记一份，
 * 见 {@link createToolFailureLog}。
 */
export class AgentToolError extends Error {
  constructor(
    readonly code: AgentToolErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AgentToolError'
  }
}

/** 提交被拒的那几种结局各归哪一类。 */
export function queueRefusalCode(kind: CreateQueueTaskOutcome['kind']): AgentToolErrorCode {
  switch (kind) {
    case 'insufficient_credits':
      return 'insufficient_credits'
    case 'quota_exceeded':
      return 'quota_exceeded'
    case 'authentication_required':
      return 'authentication_required'
    case 'invalid_input_image':
      return 'invalid_params'
    // 没有价格即这个模型不在售：与模型下线同样是「换一个做法」，不是再试一次。
    case 'price_unavailable':
      return 'model_unavailable'
    default:
      return 'upstream_error'
  }
}

/** 队列任务失败时 worker 记下的 `error_type` 各归哪一类。 */
export function taskFailureCode(errorType: TaskErrorType | null | undefined): AgentToolErrorCode {
  switch (errorType) {
    case 'upstream_timeout':
      return 'timeout'
    case 'upstream_no_image':
      return 'no_output'
    // 执行者丢了（ADR 0009）或上游的结局查不到：上游可能已经出图、已经计费，原样再跑一次
    // 就可能付两次钱，所以不归进可重试的那几类。
    case 'upstream_result_unknown':
    case 'interrupted':
      return 'result_unknown'
    default:
      return 'upstream_error'
  }
}

/**
 * 一轮里每次工具调用的失败分类。工具执行被包了一层（`agentTurnTools`），抛出去之前在这里
 * 记下分类；轮在 `tool_execution_end` 时来取。
 */
export interface ToolFailureLog {
  started(toolCallId: string): void
  failed(toolCallId: string, thrown: unknown, aborted: boolean): void
  /** 取走这次调用的分类。 */
  take(toolCallId: string, aborted: boolean): AgentToolErrorCode
}

export function createToolFailureLog(): ToolFailureLog {
  const started = new Set<string>()
  const codes = new Map<string, AgentToolErrorCode>()
  return {
    started(toolCallId) {
      started.add(toolCallId)
    },
    failed(toolCallId, thrown, aborted) {
      codes.set(
        toolCallId,
        thrown instanceof AgentToolError ? thrown.code : aborted ? 'cancelled' : 'unknown',
      )
    },
    take(toolCallId, aborted) {
      const code = codes.get(toolCallId)
      const ran = started.has(toolCallId)
      codes.delete(toolCallId)
      started.delete(toolCallId)
      if (code) return code
      if (aborted) return 'cancelled'
      // 工具根本没被调起：pi 在执行前校验参数就失败了（张数越界、缺必填项）。
      return ran ? 'unknown' : 'invalid_params'
    },
  }
}
