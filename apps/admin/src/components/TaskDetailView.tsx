import { useNavigate } from '@tanstack/react-router'
import { ImageOff, Loader2 } from 'lucide-react'

import { FuzzyTime } from '@/components/FuzzyTime'
import { ShortId } from '@/components/ShortId'
import { StatusBadge } from '@/components/StatusBadge'
import { duration, isoTime } from '@/lib/format'
import { useTask } from '@/lib/queries'
import { countInputImages, extractPrompt } from '@/lib/request-helpers'
import type { TaskDetail } from '@/lib/types'

interface TaskDetailViewProps {
  taskId: string
}

export function TaskDetailView({ taskId }: TaskDetailViewProps) {
  const q = useTask(taskId)

  if (q.isPending) {
    return (
      <div className="flex h-32 items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        加载中
      </div>
    )
  }
  if (q.isError || !q.data) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive">
        {q.error instanceof Error ? q.error.message : '加载失败'}
      </div>
    )
  }

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
        <span className="text-xs text-muted-foreground">
          提交：
          <FuzzyTime ts={task.submitted_at} />
        </span>
        <span className="text-xs text-muted-foreground">
          耗时：{duration(task.started_at, task.completed_at)}
        </span>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Request */}
        <section className="rounded-md border bg-card p-4">
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
            {task.device_id ? <KV label="device_id" value={task.device_id} mono /> : null}
            {task.attempt_count > 1 ? (
              <KV label="attempts" value={String(task.attempt_count)} mono />
            ) : null}
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

          <div className="mt-4">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              参考图 {inputImages.kind === 'count' ? `(${inputImages.count})` : null}
            </div>
            {inputImages.kind === 'count' && inputImages.count > 0 ? (
              <div className="grid grid-cols-4 gap-2">
                {Array.from({ length: inputImages.count }).map((_, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => openLightbox('input', i)}
                    className="block aspect-square overflow-hidden rounded border bg-muted"
                  >
                    <img
                      src={`/api/tasks/${encodeURIComponent(task.id)}/input-image?idx=${i}`}
                      alt={`参考图 ${i + 1}`}
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  </button>
                ))}
              </div>
            ) : inputImages.kind === 'not_archived' ? (
              <UnarchivedRef />
            ) : (
              <span className="text-xs text-muted-foreground">无</span>
            )}
          </div>
        </section>

        {/* Result */}
        <section className="rounded-md border bg-card p-4">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Result
          </h3>
          {task.error_message ? (
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
                <button
                  key={img.index}
                  type="button"
                  onClick={() => openLightbox('output', img.index)}
                  className="block aspect-square overflow-hidden rounded border bg-muted"
                >
                  <img
                    src={`/api/tasks/${encodeURIComponent(task.id)}/image?idx=${img.index}`}
                    alt={`输出图 ${img.index + 1}`}
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                </button>
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
