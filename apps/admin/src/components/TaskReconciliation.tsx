import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { apiClient } from '@/lib/api-client'

interface ReconciliationView {
  upstreamTaskIds: string[]
  dispatches: {
    id: string
    intendedAt: number
    dispatchedAt: number | null
    upstreamRequestId: string | null
  }[]
  decisions: { commandId: string; operatorId: string; evidence: string; status: string }[]
}

export function TaskReconciliation({ taskId }: { taskId: string }) {
  const queryClient = useQueryClient()
  const [evidence, setEvidence] = useState('')
  const [result, setResult] = useState('')
  const [commandId, setCommandId] = useState(() => crypto.randomUUID())
  const path = `/api/tasks/${encodeURIComponent(taskId)}/reconciliation`
  const query = useQuery({
    queryKey: ['task-reconciliation', taskId],
    queryFn: () => apiClient.get<ReconciliationView>(path),
  })
  const decision = useMutation({
    mutationFn: (action: 'lookup' | 'confirm_no_result' | 'confirm_success') =>
      apiClient.post(path, {
        commandId,
        evidence,
        action,
        ...(action === 'confirm_success' ? { result: JSON.parse(result) } : {}),
      }),
    onSuccess: async () => {
      setCommandId(crypto.randomUUID())
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['task', taskId] }),
        queryClient.invalidateQueries({ queryKey: ['task-reconciliation', taskId] }),
      ])
    },
  })
  const edit = (value: string, target: 'evidence' | 'result') => {
    setCommandId(crypto.randomUUID())
    if (target === 'evidence') setEvidence(value)
    else setResult(value)
  }
  return (
    <section className="space-y-3 rounded-md border border-amber-500/40 p-4 text-sm">
      <h3 className="font-semibold">结果核查</h3>
      <p className="text-muted-foreground">预扣保留中</p>
      {query.isError ? <p role="alert">核查记录加载失败</p> : null}
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
            </div>
          ))}
          {query.data.decisions.map((row) => (
            <div className="text-xs" key={row.commandId}>
              {row.operatorId} · {row.status} · {row.evidence}
            </div>
          ))}
        </>
      ) : null}
      <Label htmlFor={`evidence-${taskId}`}>核查依据</Label>
      <Textarea
        id={`evidence-${taskId}`}
        value={evidence}
        maxLength={4000}
        onChange={(event) => edit(event.target.value, 'evidence')}
      />
      <Label htmlFor={`result-${taskId}`}>上游结果 JSON（确认有结果时填写）</Label>
      <Textarea
        id={`result-${taskId}`}
        value={result}
        onChange={(event) => edit(event.target.value, 'result')}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={!evidence.trim() || decision.isPending}
          onClick={() => decision.mutate('lookup')}
        >
          查询原请求
        </Button>
        <Button
          variant="outline"
          disabled={!evidence.trim() || decision.isPending}
          onClick={() => decision.mutate('confirm_no_result')}
        >
          确认未产生结果
        </Button>
        <Button
          disabled={!evidence.trim() || !result.trim() || decision.isPending}
          onClick={() => decision.mutate('confirm_success')}
        >
          确认有结果
        </Button>
      </div>
      {decision.isError ? <p role="alert">核查未完成：{decision.error.message}</p> : null}
    </section>
  )
}
