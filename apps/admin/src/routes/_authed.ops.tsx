import { createFileRoute } from '@tanstack/react-router'

import { OpsBoard } from '@/components/ops/OpsBoard'
import { ErrorState, Page, PendingState } from '@/components/Page'
import { SegmentedControl } from '@/components/SegmentedControl'
import { useOps } from '@/lib/queries'
import {
  DEFAULT_OPS_RANGE,
  OPS_RANGE_LABEL,
  OPS_RANGES,
  type OpsRange,
  parseOpsSearch,
} from '@/lib/search-params'

const OPS_RANGE_OPTIONS = OPS_RANGES.map((value) => ({
  value,
  label: OPS_RANGE_LABEL[value],
}))

export const Route = createFileRoute('/_authed/ops')({
  validateSearch: parseOpsSearch,
  component: OpsPage,
})

function OpsPage() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const range = search.range ?? DEFAULT_OPS_RANGE
  const query = useOps(range)
  const setRange = (next: OpsRange) => {
    void navigate({ search: (previous) => ({ ...previous, range: next }), replace: true })
  }
  return (
    <Page
      crumbs={[{ label: '运维看板' }]}
      description={
        query.data
          ? `这套部署现在有没有出事 · 快照取于 ${new Date(query.data.generated_at).toLocaleTimeString('zh-CN', { hour12: false })}，每 30 秒刷新`
          : '这套部署现在有没有出事'
      }
      actions={
        <SegmentedControl
          options={OPS_RANGE_OPTIONS}
          value={range}
          onChange={setRange}
          label="宿主机趋势范围"
        />
      }
    >
      {/* 先看有没有上一份快照：一次刷新失败不该把还能用的看板整页清掉。 */}
      {query.data ? (
        <>
          {query.isError ? (
            <p role="status" className="mb-3 text-sm text-danger">
              上次刷新失败，下面是之前取到的快照。
            </p>
          ) : null}
          <OpsBoard snapshot={query.data} range={range} />
        </>
      ) : query.isError ? (
        <ErrorState label="运维看板加载失败" error={query.error} />
      ) : (
        <PendingState label="正在查看部署状况" />
      )}
    </Page>
  )
}
