import { createFileRoute, Link } from '@tanstack/react-router'
import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { LightboxDialog } from '@/components/LightboxDialog'
import { EmptyState, ErrorState, Page, PendingState } from '@/components/Page'
import { SegmentedControl } from '@/components/SegmentedControl'
import { TaskDetailSheet } from '@/components/TaskDetailSheet'
import { Button } from '@/components/ui/button'
import { PromptCard } from '@/features/agent-prompts/PromptCard'
import { PromptFilters } from '@/features/agent-prompts/PromptFilters'
import { PromptSummary } from '@/features/agent-prompts/PromptSummary'
import { ADMIN_REFRESH_EVENT, useAgentPrompts } from '@/lib/queries'
import { clearTaskView, parseAgentPromptsSearch } from '@/lib/search-params'
import { type AgentPromptStatus, todayWindow } from '../../contracts'

export const Route = createFileRoute('/_authed/prompts')({
  validateSearch: parseAgentPromptsSearch,
  component: AgentPromptsPage,
  errorComponent: ({ error }) => (
    <Page crumbs={[{ label: '概览', to: '/overview' }, { label: '提示词' }]}>
      <ErrorState label="提示词筛选无效" error={error} />
      <Button variant="outline" asChild>
        <Link to="/prompts" search={{}}>
          查看今天全部提示词
        </Link>
      </Button>
    </Page>
  ),
})
const statuses = [
  { value: 'all', label: '全部' },
  { value: 'awaiting', label: '待确认' },
  { value: 'running', label: '生成中' },
  { value: 'completed', label: '已完成' },
  { value: 'failed', label: '失败 / 取消' },
]
function AgentPromptsPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const [defaultWindow, setDefaultWindow] = useState(todayWindow)
  const {
    task: _task,
    fullscreen: _fullscreen,
    imgIdx: _imgIdx,
    imgKind: _imgKind,
    ...filters
  } = search
  const timeWindow =
    search.from !== undefined && search.to !== undefined
      ? { from: search.from, to: search.to }
      : defaultWindow
  const query = useAgentPrompts({ ...filters, ...timeWindow })
  useEffect(() => {
    const refresh = (event: Event) => {
      if (search.from === undefined && search.to === undefined) {
        event.preventDefault()
        setDefaultWindow(todayWindow())
      }
    }
    window.addEventListener(ADMIN_REFRESH_EVENT, refresh)
    return () => window.removeEventListener(ADMIN_REFRESH_EVENT, refresh)
  }, [search.from, search.to])
  const items = query.data?.pages.flatMap((page) => page.items) ?? []
  const summary = query.data?.pages[0]?.summary
  return (
    <>
      <Page
        crumbs={[{ label: '概览', to: '/overview' }, { label: '提示词' }]}
        description="Chat 拟出的生成提示词，包括尚未确认的草稿。"
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => {
                setDefaultWindow(todayWindow())
                void navigate({ search: {} })
              }}
            >
              今天全部
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                const to = Date.now()
                void navigate({ search: { ...filters, from: to - 7 * 86400_000, to } })
              }}
            >
              近 7 天
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label="刷新"
              disabled={query.isFetching}
              onClick={() => {
                if (search.from === undefined) setDefaultWindow(todayWindow())
                else void query.refetch()
              }}
            >
              <RefreshCw className={query.isFetching ? 'animate-spin' : undefined} />
            </Button>
          </>
        }
      >
        {summary ? <PromptSummary summary={summary} /> : null}
        <PromptFilters
          key={JSON.stringify({ ...filters, ...timeWindow })}
          filters={{ ...filters, ...timeWindow }}
          onApply={(next) => {
            void navigate({ search: next, replace: true })
          }}
          onClearTask={() => {
            const { taskId: _taskId, from: _from, to: _to, ...rest } = filters
            void navigate({ search: rest, replace: true })
          }}
        />
        <SegmentedControl
          label="提示词状态"
          options={statuses}
          value={search.status ?? 'all'}
          onChange={(status) => {
            void navigate({
              search: {
                ...filters,
                status: status === 'all' ? undefined : (status as AgentPromptStatus),
              },
              replace: true,
            })
          }}
        />
        {query.data ? (
          <>
            {query.isError ? (
              <p role="status" className="text-sm text-danger">
                刷新失败，下面是之前的记录。
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              已加载 {items.length} 条 · 从新到旧 · 时间均为北京时间
            </p>
            {items.length ? (
              <div className="space-y-4">
                {items.map((item) => (
                  <PromptCard
                    key={`${item.kind}:${item.id}`}
                    item={item}
                    onTask={(task) => {
                      void navigate({ search: { ...search, task } })
                    }}
                  />
                ))}
              </div>
            ) : (
              <EmptyState label="没有符合条件的提示词" />
            )}
            {query.hasNextPage ? (
              <Button
                variant="outline"
                disabled={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchingNextPage ? '加载中…' : '加载更多'}
              </Button>
            ) : null}
          </>
        ) : query.isPending ? (
          <PendingState label="加载提示词…" />
        ) : (
          <ErrorState label="提示词加载失败" error={query.error} />
        )}
      </Page>
      <TaskDetailSheet
        taskId={search.task}
        onOpenChange={(open) => {
          if (!open) void navigate({ search: clearTaskView })
        }}
      />
      <LightboxDialog
        taskId={search.task}
        fullscreen={search.fullscreen}
        imgIdx={search.imgIdx}
        imgKind={search.imgKind}
      />
    </>
  )
}
