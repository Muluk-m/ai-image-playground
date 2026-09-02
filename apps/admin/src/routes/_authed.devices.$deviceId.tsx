import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMemo } from 'react'

import { DeviceMetaCard } from '@/components/DeviceMetaCard'
import { LightboxDialog } from '@/components/LightboxDialog'
import { EmptyState, ErrorState, Page, PendingState } from '@/components/Page'
import { RangeToggle } from '@/components/RangeToggle'
import { TaskDetailSheet } from '@/components/TaskDetailSheet'
import { TaskTable } from '@/components/TaskTable'
import { shortId } from '@/lib/format'
import { useDeviceDetail } from '@/lib/queries'
import { clearTaskView, parseDeviceDetailSearch } from '@/lib/search-params'
import { useRangeSearch } from '@/lib/useRangeSearch'

export const Route = createFileRoute('/_authed/devices/$deviceId')({
  validateSearch: parseDeviceDetailSearch,
  component: DeviceDetailPage,
})

function DeviceDetailPage() {
  const { deviceId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = useNavigate()
  const [range, setRange] = useRangeSearch()
  const q = useDeviceDetail(deviceId, range)
  // useInfiniteQuery：设备聚合卡片只在首页返回；任务跨页累积。
  const pages = q.data?.pages ?? []
  const device = pages[0]?.device ?? null
  const tasks = useMemo(() => pages.flatMap((page) => page.tasks), [pages])
  const runningCount = useMemo(
    () => tasks.filter((task) => task.status === 'in_progress' || task.status === 'queued').length,
    [tasks],
  )

  function closeTask(): void {
    void navigate({ to: '.', search: clearTaskView })
  }

  return (
    <>
      <Page
        crumbs={[{ label: '设备', to: '/devices' }, { label: shortId(deviceId) }]}
        title="设备详情"
        description={deviceId}
      >
        {q.isPending ? (
          <PendingState label="加载设备详情" />
        ) : q.isError ? (
          <ErrorState label="加载失败" error={q.error} />
        ) : !device ? (
          <EmptyState label={`未找到设备 ${deviceId}`} />
        ) : (
          <>
            <DeviceMetaCard device={device} range={range} runningCount={runningCount} />
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
      </Page>

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
