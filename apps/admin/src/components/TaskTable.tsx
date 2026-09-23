import { useNavigate } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Loader2, RotateCcw } from 'lucide-react'
import { useEffect, useRef } from 'react'

import { FuzzyTime } from '@/components/FuzzyTime'
import { EmptyState } from '@/components/Page'
import { StatusBadge } from '@/components/StatusBadge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIsMobile } from '@/hooks/use-mobile'
import { duration, shortId } from '@/lib/format'
import type { TaskListItem } from '@/lib/types'

interface TaskTableProps {
  tasks: TaskListItem[]
  /** 还有下一页可加载（来自 useInfiniteQuery） */
  hasNextPage?: boolean
  /** 正在拉下一页 */
  isFetchingNextPage?: boolean
  /** 滚动接近底部时触发加载下一页 */
  onLoadMore?: () => void
}

// 固定行高：移动端 prompt 两行，其余字段单行；桌面端全部单行。虚拟化无需逐行测量。
const DESKTOP_ROW_HEIGHT = 44
const MOBILE_ROW_HEIGHT = 140

export function TaskTable({ tasks, hasNextPage, isFetchingNextPage, onLoadMore }: TaskTableProps) {
  const navigate = useNavigate()
  const parentRef = useRef<HTMLDivElement>(null)
  const isMobile = useIsMobile()

  const rowVirtualizer = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => (isMobile ? MOBILE_ROW_HEIGHT : DESKTOP_ROW_HEIGHT),
    overscan: 12,
  })

  const virtualItems = rowVirtualizer.getVirtualItems()
  const lastIndex = virtualItems[virtualItems.length - 1]?.index ?? -1

  // 滚到接近底部（最后一个可见虚拟行到达列表末尾）时拉下一页。
  useEffect(() => {
    if (lastIndex >= tasks.length - 1 && hasNextPage && !isFetchingNextPage) {
      onLoadMore?.()
    }
  }, [lastIndex, tasks.length, hasNextPage, isFetchingNextPage, onLoadMore])
  useEffect(() => {
    rowVirtualizer.measure()
  }, [rowVirtualizer, isMobile])

  function openTask(taskId: string): void {
    void navigate({
      to: '.',
      search: (prev) => ({ ...(prev ?? {}), task: taskId }),
    })
  }

  if (!tasks.length) return <EmptyState label="没有匹配的任务" />

  return (
    <div className="rounded-lg border bg-card">
      {/* 表头：与行用同一套列宽 class 对齐 */}
      <div className="hidden items-center gap-3 border-b px-4 py-2 text-xs font-medium text-muted-foreground md:flex">
        <div className="w-[140px] shrink-0">提交时间</div>
        <div className="w-[140px] shrink-0">状态</div>
        <div className="w-[140px] shrink-0">模型</div>
        <div className="min-w-0 flex-1">Prompt</div>
        <div className="w-[48px] shrink-0 text-right">调用</div>
        <div className="w-[72px] shrink-0 text-right">耗时</div>
        <div className="w-[96px] shrink-0">ID</div>
      </div>

      {/* 滚动视口：虚拟化只渲染可见行，几千上万条也不会撑爆 DOM */}
      <div
        ref={parentRef}
        className="max-h-[calc(100vh-280px)] min-h-[200px] overflow-auto md:max-h-[calc(100vh-340px)]"
      >
        <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualItems.map((vi) => {
            const t = tasks[vi.index]
            if (!t) return null
            if (isMobile) {
              return (
                <button
                  key={t.id}
                  type="button"
                  className="absolute left-0 top-0 flex w-full flex-col items-stretch gap-2 border-b px-4 py-3 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  style={{ height: MOBILE_ROW_HEIGHT, transform: `translateY(${vi.start}px)` }}
                  onClick={() => openTask(t.id)}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <StatusBadge status={t.status} />
                    {t.attempt_count > 1 ? (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground tabular-nums">
                        <RotateCcw className="h-3 w-3" />
                        {t.attempt_count}
                      </span>
                    ) : null}
                    {t.upstream_status ? (
                      <span className="rounded bg-destructive/10 px-1 font-mono text-[10px] text-destructive tabular-nums">
                        HTTP {t.upstream_status}
                      </span>
                    ) : null}
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      <FuzzyTime ts={t.submitted_at} />
                    </span>
                  </span>
                  <span className="truncate font-mono text-xs">{t.model}</span>
                  <span className="min-h-8 text-xs text-muted-foreground">
                    <PromptCell text={t.prompt} lines={2} />
                  </span>
                  <span className="flex items-center justify-between gap-3 font-mono text-[10px] text-muted-foreground">
                    <span>{shortId(t.id)}</span>
                    <span>
                      {t.upstream_invocation_count} 次调用 ·{' '}
                      {duration(t.started_at, t.completed_at)}
                    </span>
                  </span>
                </button>
              )
            }
            return (
              <div
                key={t.id}
                className="absolute left-0 top-0 flex w-full cursor-pointer items-center gap-3 border-b px-4 text-sm hover:bg-muted/40"
                style={{ height: DESKTOP_ROW_HEIGHT, transform: `translateY(${vi.start}px)` }}
                onClick={() => openTask(t.id)}
              >
                <div className="w-[140px] shrink-0">
                  <FuzzyTime ts={t.submitted_at} />
                </div>
                <div className="w-[140px] shrink-0">
                  <div className="flex items-center gap-1.5">
                    <StatusBadge status={t.status} />
                    {t.attempt_count > 1 ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground tabular-nums">
                            <RotateCcw className="h-3 w-3" />
                            {t.attempt_count}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="text-xs">
                          已尝试 {t.attempt_count} 次（含首次）
                        </TooltipContent>
                      </Tooltip>
                    ) : null}
                    {t.upstream_status ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="rounded bg-destructive/10 px-1 font-mono text-[10px] text-destructive tabular-nums">
                            {t.upstream_status}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="text-xs">
                          上游返回 HTTP {t.upstream_status}
                        </TooltipContent>
                      </Tooltip>
                    ) : null}
                  </div>
                </div>
                <div className="w-[140px] shrink-0 truncate font-mono text-xs">{t.model}</div>
                <div className="min-w-0 flex-1">
                  <PromptCell text={t.prompt} />
                </div>
                <div className="w-[48px] shrink-0 text-right font-mono text-xs tabular-nums">
                  {t.upstream_invocation_count}
                </div>
                <div className="w-[72px] shrink-0 text-right font-mono text-xs tabular-nums">
                  {duration(t.started_at, t.completed_at)}
                </div>
                <div className="w-[96px] shrink-0">
                  <span className="font-mono text-xs text-muted-foreground">{shortId(t.id)}</span>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {isFetchingNextPage ? (
        <div className="flex items-center justify-center gap-2 border-t py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          加载更多…
        </div>
      ) : null}
    </div>
  )
}

function PromptCell({ text, lines = 1 }: { text: string; lines?: 1 | 2 }) {
  if (!text) return <span className="text-xs text-muted-foreground">—</span>
  const truncated = text.length > 160 ? `${text.slice(0, 160)}…` : text
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`${lines === 2 ? 'line-clamp-2' : 'line-clamp-1'} text-xs`}>
          {truncated}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[min(28rem,calc(100vw-2rem))] whitespace-pre-wrap break-words text-xs">
        {text}
      </TooltipContent>
    </Tooltip>
  )
}
