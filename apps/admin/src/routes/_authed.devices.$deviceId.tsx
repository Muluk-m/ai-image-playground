import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ChevronLeft, Loader2 } from 'lucide-react'

import { DeviceMetaCard } from '@/components/DeviceMetaCard'
import { LightboxDialog } from '@/components/LightboxDialog'
import { TaskDetailSheet } from '@/components/TaskDetailSheet'
import { TaskTable } from '@/components/TaskTable'
import { Button } from '@/components/ui/button'
import { useDeviceDetail } from '@/lib/queries'
import { parseDeviceDetailSearch } from '@/lib/search-params'

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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void navigate({ to: '/devices' })
          }}
        >
          <ChevronLeft />
          返回设备列表
        </Button>
      </div>

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
          <div className="flex items-baseline justify-between pt-2">
            <h3 className="text-sm font-semibold">任务</h3>
            <span className="text-xs text-muted-foreground">
              已加载 {tasks.length} / 共 {device.total}
            </span>
          </div>
          <TaskTable
            tasks={tasks}
            deviceId={deviceId}
            hasNextPage={q.hasNextPage}
            isFetchingNextPage={q.isFetchingNextPage}
            onLoadMore={() => {
              void q.fetchNextPage()
            }}
          />
        </>
      )}

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
    </div>
  )
}
