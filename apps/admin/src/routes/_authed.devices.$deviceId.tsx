import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'

import { DeviceMetaCard } from '@/components/DeviceMetaCard'
import { LightboxDialog } from '@/components/LightboxDialog'
import { PageHeader } from '@/components/PageHeader'
import { RangeToggle } from '@/components/RangeToggle'
import { TaskDetailSheet } from '@/components/TaskDetailSheet'
import { TaskTable } from '@/components/TaskTable'
import { shortId } from '@/lib/format'
import { useDeviceDetail } from '@/lib/queries'
import { parseDeviceDetailSearch, type Range } from '@/lib/search-params'

export const Route = createFileRoute('/_authed/devices/$deviceId')({
  validateSearch: parseDeviceDetailSearch,
  component: DeviceDetailPage,
})

function DeviceDetailPage() {
  const { deviceId } = Route.useParams()
  const search = Route.useSearch()
  const range = search.range ?? '7d'
  const navigate = useNavigate()
  const q = useDeviceDetail(deviceId, range)
  // useInfiniteQuery：设备聚合卡片只在首页返回；任务跨页累积。
  const pages = q.data?.pages ?? []
  const device = pages[0]?.device ?? null
  const tasks = pages.flatMap((p) => p.tasks)

  function setRange(next: Range): void {
    void navigate({
      to: '.',
      search: (previous) => ({ ...previous, range: next }),
      replace: true,
    })
  }

  function closeTask(): void {
    void navigate({
      to: '.',
      search: (prev) => {
        const { task: _task, fullscreen: _fs, imgIdx: _i, imgKind: _k, ...rest } = prev ?? {}
        return rest
      },
    })
  }

  return (
    <>
      <PageHeader
        crumbs={[{ label: '设备', to: '/devices' }, { label: shortId(deviceId) }]}
        title="设备详情"
        description={deviceId}
      />

      <div className="flex-1 space-y-4 px-4 py-5 md:px-6">
        {q.isPending ? (
          <div className="flex h-32 items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载中
          </div>
        ) : q.isError ? (
          <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-6 text-sm text-destructive">
            加载失败：{(q.error as Error).message}
          </div>
        ) : !device ? (
          <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
            未找到设备 {deviceId}
          </div>
        ) : (
          <>
            <DeviceMetaCard
              device={device}
              range={range}
              runningCount={
                tasks.filter((t) => t.status === 'in_progress' || t.status === 'queued').length
              }
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">
                任务
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                  已加载 {tasks.length} / 共 {device.total}
                </span>
              </h2>
              <RangeToggle value={range} onChange={setRange} />
            </div>
            <TaskTable
              tasks={tasks}
              hasNextPage={q.hasNextPage}
              isFetchingNextPage={q.isFetchingNextPage}
              onLoadMore={() => {
                void q.fetchNextPage()
              }}
            />
          </>
        )}
      </div>

      <TaskDetailSheet
        taskId={search.task}
        onOpenChange={(open) => {
          if (!open) closeTask()
        }}
      />
      <LightboxDialog
        taskId={search.task}
        imgIdx={search.imgIdx}
        imgKind={search.imgKind}
        fullscreen={search.fullscreen}
      />
    </>
  )
}
