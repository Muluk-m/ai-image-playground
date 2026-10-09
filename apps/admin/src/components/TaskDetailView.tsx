import { useNavigate } from '@tanstack/react-router'
import { ImageOff } from 'lucide-react'

import { FuzzyTime } from '@/components/FuzzyTime'
import { ErrorState, PendingState } from '@/components/Page'
import { ShortId } from '@/components/ShortId'
import { StatusBadge } from '@/components/StatusBadge'
import { TaskReconciliation } from '@/components/TaskReconciliation'
import { Button } from '@/components/ui/button'
import { duration, isoTime } from '@/lib/format'
import { useTask } from '@/lib/queries'
import { countInputImages, extractPrompt } from '@/lib/request-helpers'
import { adminApiUrl } from '@/lib/runtime-config'
import type { TaskDetail } from '@/lib/types'

interface TaskDetailViewProps {
  taskId: string
}

export function TaskDetailView({ taskId }: TaskDetailViewProps) {
  const q = useTask(taskId)

  if (q.isPending) return <PendingState label="加载任务详情" />
  if (q.isError || !q.data) return <ErrorState label="加载失败" error={q.error} />

  return <TaskDetailContent task={q.data} />
}

function TaskDetailContent({ task }: { task: TaskDetail }) {
  const navigate = useNavigate()
  const req = (task.request_payload ?? {}) as Record<string, unknown>
  const inputImages = countInputImages(task.provider, req)
  const outputImages = task.result_meta.images

  function openLightbox(kind: 'output' | 'input', idx: number): void {
    void navigate({
      to: '.',
      search: (prev) => ({
        ...(prev ?? {}),
        task: task.id,
        fullscreen: '1',
        imgIdx: idx,
        imgKind: kind,
      }),
    })
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-baseline gap-3 border-b pb-3">
        <ShortId value={task.id} len={12} className="text-sm" />
        <StatusBadge status={task.status} />
        {task.kind === 'analysis' ? <span className="text-xs font-medium">图片分析</span> : null}
        <span className="text-xs text-muted-foreground">
          提交：
          <FuzzyTime ts={task.submitted_at} />
        </span>
        <span className="text-xs text-muted-foreground">
          耗时：{duration(task.started_at, task.completed_at)}
        </span>
      </header>

      {task.status === 'reconciling' ? <TaskReconciliation taskId={task.id} /> : null}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Request */}
        <section className="min-w-0 rounded-md border bg-card p-3 sm:p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Request
          </h3>
          <dl className="space-y-2 text-xs">
            <KV label="provider" value={task.provider} mono />
            <KV label="model" value={task.model} mono />
            {typeof req.n === 'number' ? <KV label="n" value={String(req.n)} mono /> : null}
            {typeof req.size === 'string' ? <KV label="size" value={req.size} mono /> : null}
            {typeof req.quality === 'string' ? (
              <KV label="quality" value={req.quality} mono />
            ) : null}
            {typeof req.background === 'string' ? (
              <KV label="background" value={req.background} mono />
            ) : null}
            {task.user_id ? (
              <div className="grid min-w-0 grid-cols-[88px_minmax(0,1fr)] gap-3 sm:grid-cols-[110px_1fr]">
                <dt className="text-muted-foreground">user_id</dt>
                <dd>
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto justify-start whitespace-normal break-all p-0 text-left font-mono underline-offset-2"
                    onClick={() =>
                      void navigate({
                        to: '/users/$userId',
                        params: { userId: task.user_id! },
                      })
                    }
                  >
                    {task.user_id}
                  </Button>
                </dd>
              </div>
            ) : task.device_id ? (
              <div className="grid min-w-0 grid-cols-[88px_minmax(0,1fr)] gap-3 sm:grid-cols-[110px_1fr]">
                <dt className="text-muted-foreground">device_id</dt>
                <dd>
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto justify-start whitespace-normal break-all p-0 text-left font-mono underline-offset-2"
                    onClick={() =>
                      void navigate({
                        to: '/devices/$deviceId',
                        params: { deviceId: task.device_id! },
                      })
                    }
                  >
                    {task.device_id}
                  </Button>
                </dd>
              </div>
            ) : null}
            {task.attempt_count > 1 ? (
              <KV label="attempts" value={String(task.attempt_count)} mono />
            ) : null}
            <KV label="upstream_calls" value={String(task.upstream_invocation_count)} mono />
            {task.status === 'queued' && task.next_retry_at ? (
              <KV label="next_retry_at" value={isoTime(task.next_retry_at)} mono />
            ) : null}
            {task.started_at ? (
              <KV label="started_at" value={isoTime(task.started_at)} mono />
            ) : null}
            {task.completed_at ? (
              <KV label="completed_at" value={isoTime(task.completed_at)} mono />
            ) : null}
          </dl>

          <div className="mt-4">
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Prompt
            </div>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-3 font-mono text-xs">
              {extractPrompt(req) || '(空)'}
            </pre>
          </div>

          {!task.analysis ? (
            <div className="mt-4">
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                参考图 {inputImages.kind === 'count' ? `(${inputImages.count})` : null}
              </div>
              {inputImages.kind === 'count' && inputImages.count > 0 ? (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {Array.from({ length: inputImages.count }).map((_, i) => (
                    <Button
                      key={i}
                      type="button"
                      variant="ghost"
                      onClick={() => openLightbox('input', i)}
                      className="block aspect-square h-auto w-full overflow-hidden rounded border bg-muted p-0 hover:bg-muted"
                    >
                      <img
                        src={adminApiUrl(
                          `/api/tasks/${encodeURIComponent(task.id)}/input-image?idx=${i}`,
                        )}
                        alt={`参考图 ${i + 1}`}
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    </Button>
                  ))}
                </div>
              ) : inputImages.kind === 'not_archived' ? (
                <UnarchivedRef />
              ) : (
                <span className="text-xs text-muted-foreground">无</span>
              )}
            </div>
          ) : null}
        </section>

        {/* Result */}
        <section className="min-w-0 rounded-md border bg-card p-3 sm:p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {task.analysis ? '图片分析结果' : 'Result'}
          </h3>
          {task.analysis ? (
            <AnalysisResult analysis={task.analysis} error={task.error_message} />
          ) : task.error_message ? (
            <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-xs">
              <div className="mb-1 flex items-center gap-2">
                <span className="font-medium text-destructive">{task.error_type ?? 'error'}</span>
                {task.upstream_status ? (
                  <span className="rounded bg-destructive/10 px-1.5 py-0.5 font-mono text-[10px] text-destructive">
                    上游 HTTP {task.upstream_status}
                  </span>
                ) : null}
              </div>
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-destructive/90">
                {task.error_message}
              </pre>
              {task.upstream_body ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-[11px] text-destructive/80">
                    上游原始响应
                  </summary>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-destructive/5 p-2 font-mono text-[11px] text-destructive/90">
                    {task.upstream_body}
                  </pre>
                </details>
              ) : null}
            </div>
          ) : outputImages.length === 0 ? (
            <div className="rounded border border-dashed p-6 text-center text-xs text-muted-foreground">
              <ImageOff className="mx-auto mb-2 h-5 w-5 opacity-50" />
              无输出图
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {outputImages.map((img) => (
                <Button
                  key={img.index}
                  type="button"
                  variant="ghost"
                  onClick={() => openLightbox('output', img.index)}
                  className="block aspect-square h-auto w-full overflow-hidden rounded border bg-muted p-0 hover:bg-muted"
                >
                  <img
                    src={adminApiUrl(
                      `/api/tasks/${encodeURIComponent(task.id)}/image?idx=${img.index}`,
                    )}
                    alt={`输出图 ${img.index + 1}`}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                </Button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function KV({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? 'font-mono' : ''}>{value}</dd>
    </div>
  )
}

function UnarchivedRef() {
  return (
    <div className="flex items-center gap-2 rounded border border-dashed px-3 py-2 text-xs text-muted-foreground">
      <ImageOff className="h-4 w-4 opacity-60" />
      <span>参考图未存档（OpenAI multipart 直传未持久化）</span>
    </div>
  )
}

function AnalysisResult({
  analysis,
  error,
}: {
  analysis: NonNullable<TaskDetail['analysis']>
  error: string | null
}) {
  return (
    <div className="space-y-3 text-xs">
      <div className="flex flex-wrap gap-3">
        <span>预扣 {analysis.reservedCredits} 积分</span>
        <span>
          {analysis.actualCredits === null ? '费用待核实' : `实扣 ${analysis.actualCredits} 积分`}
        </span>
        {analysis.pricing.exemption === 'chat-free' ? <span>对话免单</span> : null}
        {analysis.pricing.exemption === 'non-billing' ? <span>未启用计费</span> : null}
      </div>
      {analysis.coverage ? (
        <p>
          已检查 {analysis.coverage.reviewedImageIds.length} /{' '}
          {analysis.coverage.requiredImageIds.length} 张
        </p>
      ) : (
        <p>覆盖范围待核实</p>
      )}
      {analysis.coverage?.missingImageIds.length ? (
        <p>未检查：{analysis.coverage.missingImageIds.join('、')}</p>
      ) : null}
      {analysis.usage ? (
        <p>
          输入 {analysis.usage.inputTokens} · 缓存 {analysis.usage.cachedInputTokens ?? 0} · 输出{' '}
          {analysis.usage.outputTokens} tokens
        </p>
      ) : (
        <p>用量未知</p>
      )}
      {analysis.findings?.map((finding) => (
        <div className="rounded border p-3" key={finding.imageId}>
          <div className="mb-1 font-mono text-muted-foreground">{finding.imageId}</div>
          <p className="whitespace-pre-wrap break-words">{finding.text}</p>
        </div>
      ))}
      {analysis.evidence?.map((evidence, index) => (
        <p className="text-muted-foreground" key={`${evidence.imageId ?? 'image'}:${index}`}>
          {evidence.imageId ?? '图片'} · {evidence.width} × {evidence.height} · {evidence.bytes}{' '}
          bytes · {evidence.representation}
        </p>
      ))}
      {analysis.upstreamRequestId ? (
        <p className="break-all font-mono">请求：{analysis.upstreamRequestId}</p>
      ) : null}
      {error ? <p className="text-destructive">{error}</p> : null}
    </div>
  )
}
