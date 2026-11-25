import { createFileRoute, Link } from '@tanstack/react-router'

import { HealthMonitorBoard } from '@/components/health/HealthMonitorBoard'
import { ErrorState, Page, PendingState } from '@/components/Page'
import { SegmentedControl } from '@/components/SegmentedControl'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useHealthMonitor } from '@/lib/queries'
import {
  DEFAULT_HEALTH_RANGE,
  HEALTH_RANGE_META,
  HEALTH_RANGES,
  type HealthRange,
  parseHealthSearch,
} from '@/lib/search-params'

const HEALTH_RANGE_OPTIONS = HEALTH_RANGES.map((value) => ({
  value,
  label: HEALTH_RANGE_META[value].label,
}))

export const Route = createFileRoute('/_authed/health')({
  validateSearch: parseHealthSearch,
  component: HealthMonitorPage,
})

function HealthMonitorPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const range = search.range ?? DEFAULT_HEALTH_RANGE
  const includePolicy = search.includePolicy === '1'
  const query = useHealthMonitor(range, includePolicy)

  const setRange = (next: HealthRange) => {
    void navigate({
      search: (previous) => ({ ...previous, range: next }),
      replace: true,
    })
  }

  const setIncludePolicy = (checked: boolean) => {
    void navigate({
      search: (previous) => ({
        ...previous,
        includePolicy: checked ? '1' : undefined,
      }),
      replace: true,
    })
  }

  return (
    <Page
      crumbs={[{ label: '健康监测' }]}
      description={
        query.data
          ? `生成任务、Agent 首字延迟（TTFT）与核心接口可用率 · 快照取于 ${new Date(query.data.generated_at).toLocaleTimeString('zh-CN', { hour12: false })}，每 30 秒刷新`
          : '生成任务、Agent 首字延迟（TTFT）与核心接口可用率'
      }
      actions={
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Switch
              checked={includePolicy}
              onCheckedChange={setIncludePolicy}
              aria-label="计入内容安全拒图"
            />
            <span>含策略拒图</span>
          </label>
          <SegmentedControl
            options={HEALTH_RANGE_OPTIONS}
            value={range}
            onChange={setRange}
            label="健康监测时间窗口"
          />
        </div>
      }
    >
      {query.data ? (
        <>
          {query.isError ? (
            <p role="status" className="mb-3 text-sm text-danger">
              上次刷新失败，下面是之前取到的快照。
            </p>
          ) : null}
          <HealthMonitorBoard snapshot={query.data} />
        </>
      ) : query.isError ? (
        <ErrorState label="健康监测加载失败" error={query.error} />
      ) : (
        <PendingState label="正在聚合生成任务与 TTFT 健康状态" />
      )}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button variant="outline" asChild>
          <Link to="/ops">查看运维看板</Link>
        </Button>
        <Button variant="outline" asChild>
          <Link to="/tasks">查看生成任务</Link>
        </Button>
      </div>
    </Page>
  )
}
