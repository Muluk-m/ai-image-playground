import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ApiError, apiClient } from '@/lib/api-client'

interface ReconciliationResult {
  taskId: string
  status: 'reconciling' | 'completed' | 'failed'
  reason?: string
}
interface ReconciliationView {
  kind?: 'queue' | 'analysis'
  status: string
  upstreamTaskIds: string[]
  dispatches: {
    id: string
    intendedAt: number
    dispatchedAt: number | null
    upstreamRequestId: string | null
    upstreamTaskId?: string | null
  }[]
  decisions: {
    commandId: string
    operatorId: string
    evidence: string
    status: string
    reason?: string
  }[]
}
interface Command {
  commandId: string
  evidence: string
  action: 'lookup' | 'confirm_no_result' | 'confirm_success'
  result?: Record<string, unknown>
}
const reasons: Record<string, string> = {
  manual_verification_required: '需要向上游核实，再提供核查依据或完整结果。',
  upstream_result_unknown: '上游结果仍未确认，请稍后查询原请求。预扣继续保留。',
  archive_incomplete: '结果尚未保存完整，请检查存储服务后重新查询原请求。预扣继续保留。',
  reconciliation_in_progress: '原核查仍在执行，请刷新记录或重试原核查。',
  reconciliation_lookup_required: '请先查询原请求，再提交确认结论。',
  reconciliation_busy: '其他核查正在执行，请稍后刷新记录。',
  reconciliation_command_conflict: '该命令已绑定其他提交内容，请刷新核查记录。',
  reconciliation_evidence_required: '请填写核查依据。',
  reconciliation_result_required: '请提供包含可交付图片的上游结果 JSON。',
  analysis_result_required:
    '请提供完整 findings 和已核实的 usage（inputTokens、outputTokens，可选 cachedInputTokens）；联合比较还需提供 comparison。',
  reconciliation_lease_lost: '本次核查已失去执行权，请刷新记录确认最新结果。',
  task_not_reconciling: '任务已不在待核查状态，请刷新记录。',
  reconciliation_kind_unsupported: '该任务类型暂不支持此核查入口。',
  task_not_found: '任务不存在或已被清理。',
}
const uncertainMessage =
  '执行结果尚不确定，请刷新核查记录或重试原核查；确认结果前不能改为其他操作。'
function errorCode(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || !error.body || typeof error.body !== 'object')
    return undefined
  const body = error.body as { error?: unknown }
  return typeof body.error === 'string' ? body.error : undefined
}

export function TaskReconciliation({ taskId }: { taskId: string }) {
  return <TaskReconciliationForm key={taskId} taskId={taskId} />
}

function TaskReconciliationForm({ taskId }: { taskId: string }) {
  const queryClient = useQueryClient()
  const [evidence, setEvidence] = useState('')
  const [result, setResult] = useState('')
  const [unresolved, setUnresolved] = useState<Command | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const path = `/api/tasks/${encodeURIComponent(taskId)}/reconciliation`
  const queryKey = ['task-reconciliation', taskId]
  const query = useQuery({
    queryKey,
    queryFn: () => apiClient.get<ReconciliationView>(path),
  })
  const refresh = async () => {
    const records = await query.refetch()
    if (!records.isSuccess) return
    await queryClient.invalidateQueries({ queryKey: ['task', taskId] })
    if (records.data.status !== 'reconciling') {
      setUnresolved(null)
      setNotice(null)
      return
    }
    const recorded =
      unresolved && records.data?.decisions.find((row) => row.commandId === unresolved.commandId)
    if (recorded) {
      setUnresolved(null)
      setNotice(
        recorded.status === 'reconciling'
          ? (reasons[recorded.reason ?? ''] ?? '核查尚未完成，请查看记录后继续处理。')
          : null,
      )
    }
  }
  const decision = useMutation({
    mutationFn: (command: Command) => apiClient.post<ReconciliationResult>(path, command),
    onSuccess: async (response, command) => {
      const inProgress =
        response.status === 'reconciling' && response.reason === 'reconciliation_in_progress'
      setUnresolved(inProgress ? command : null)
      setNotice(
        response.status === 'reconciling'
          ? (reasons[response.reason ?? ''] ?? '核查尚未完成，请查看记录后继续处理。')
          : null,
      )
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['task', taskId] }),
        queryClient.invalidateQueries({ queryKey }),
      ])
    },
    onError: (error, command) => {
      const code = errorCode(error)
      const uncertain =
        !(error instanceof ApiError) ||
        error.status >= 500 ||
        code === 'reconciliation_result_uncertain'
      setUnresolved(uncertain ? command : null)
      setNotice(
        uncertain ? uncertainMessage : (reasons[code ?? ''] ?? `核查未完成：${error.message}`),
      )
    },
  })
  const submit = (action: Command['action']) => {
    if (decision.isPending || unresolved) return
    let parsed: Record<string, unknown> | undefined
    if (action === 'confirm_success') {
      try {
        const value: unknown = JSON.parse(result)
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('invalid result')
        parsed = value as Record<string, unknown>
      } catch {
        setNotice('结果 JSON 格式无效，请检查后重试。')
        return
      }
    }
    setNotice(null)
    decision.mutate({
      commandId: crypto.randomUUID(),
      evidence,
      action,
      ...(parsed ? { result: parsed } : {}),
    })
  }
  const terminal = ['completed', 'failed', 'cancelled'].includes(query.data?.status ?? '')
  const locked = decision.isPending || unresolved !== null || terminal
  return (
    <section className="space-y-3 rounded-md border border-amber-500/40 p-4 text-sm">
      <h3 className="font-semibold">结果核查</h3>
      <p className="text-muted-foreground">{terminal ? '核查已结束' : '预扣保留中'}</p>
      {query.isError ? <p role="alert">核查记录加载失败，请刷新后重试。</p> : null}
      {query.data ? (
        <>
          <div className="break-all text-xs">
            上游任务：{query.data.upstreamTaskIds.join('、') || '未取得任务编号'}
          </div>
          {query.data.dispatches.map((row) => (
            <div className="break-all text-xs" key={row.id}>
              {new Date(row.intendedAt).toLocaleString()} ·{' '}
              {row.dispatchedAt ? '已派发' : '派发未确认'} ·{' '}
              {row.upstreamRequestId ?? '未取得请求编号'}
              {row.upstreamTaskId ? ` · ${row.upstreamTaskId}` : ''}
            </div>
          ))}
          {query.data.decisions.map((row) => (
            <div className="text-xs" key={row.commandId}>
              {row.operatorId} · {row.status} · {row.evidence}
              {row.reason ? ` · ${reasons[row.reason] ?? '核查尚未完成，请继续核实。'}` : ''}
            </div>
          ))}
        </>
      ) : null}
      <Label htmlFor={`evidence-${taskId}`}>核查依据</Label>
      <Textarea
        id={`evidence-${taskId}`}
        value={evidence}
        maxLength={4000}
        disabled={locked}
        onChange={(event) => setEvidence(event.target.value)}
      />
      {query.data?.kind === 'analysis' ? (
        <p className="text-xs text-muted-foreground">
          请核实原分析请求的逐图结论和 token 用量；未知用量不能填写为 0。 联合比较还需提供
          comparison：status 为 completed，imageIds 列出全部比较图片，text 填写已核实的比较结论。
        </p>
      ) : null}
      <Label htmlFor={`result-${taskId}`}>
        {query.data?.kind === 'analysis'
          ? '分析结果 JSON（findings 和 usage）'
          : '上游结果 JSON（确认有结果时填写）'}
      </Label>
      <Textarea
        id={`result-${taskId}`}
        value={result}
        disabled={locked}
        onChange={(event) => setResult(event.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={!evidence.trim() || locked}
          onClick={() => submit('lookup')}
        >
          查询原请求
        </Button>
        <Button
          variant="outline"
          disabled={!evidence.trim() || locked}
          onClick={() => submit('confirm_no_result')}
        >
          确认未产生结果
        </Button>
        <Button
          disabled={!evidence.trim() || !result.trim() || locked}
          onClick={() => submit('confirm_success')}
        >
          确认有结果
        </Button>
        {unresolved ? (
          <Button
            variant="outline"
            disabled={decision.isPending}
            onClick={() => decision.mutate(unresolved)}
          >
            重试原核查
          </Button>
        ) : null}
        <Button
          variant="outline"
          disabled={query.isFetching || decision.isPending}
          onClick={() => {
            void refresh()
          }}
        >
          刷新核查记录
        </Button>
      </div>
      {notice ? <p role="alert">{notice}</p> : null}
    </section>
  )
}
