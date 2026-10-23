import { submitErrorCodeOf } from '../../../lib/channels/queueClient'

/**
 * 节点任务被 BFF 拒绝时的错误码，按节点任务 id 记在本页内存里。
 *
 * 节点上那条错误任务只存给人看的文案（会同步到别的标签页），码不进文档；阶段授权的批量运行
 * 在同一个标签页里等这条任务，读一次就拿走，用它决定要不要重试、向智能体报哪个原因。
 */
const codes = new Map<string, string>()
const MAX_REMEMBERED = 200

export function noteNodeJobFailure(jobId: string, error: unknown): void {
  const code = submitErrorCodeOf(error)
  if (!code) return
  if (codes.size >= MAX_REMEMBERED) codes.delete(codes.keys().next().value!)
  codes.set(jobId, code)
}

export function takeNodeJobFailure(jobId: string): string | undefined {
  const code = codes.get(jobId)
  codes.delete(jobId)
  return code
}
