import type { SpendActivity } from '@image-playground/shared'
import { useQuery } from '@tanstack/react-query'
import * as HeatGraph from 'heat-graph'
import { apiClient } from '../../lib/private-host'
import { credits, Section } from './shared'

const CELL_SIZE = 10
const CELL_GAP = 3
const CELL_PITCH = CELL_SIZE + CELL_GAP
const MONTH_ROW_HEIGHT = 16
const GRAPH_HEIGHT = MONTH_ROW_HEIGHT + 7 * CELL_SIZE + 6 * CELL_GAP

const MONTH_ROW_STYLE = { height: `${MONTH_ROW_HEIGHT}px` }
const GRID_STYLE = { gap: `${CELL_GAP}px`, gridTemplateRows: `repeat(7, ${CELL_SIZE}px)` }
const CELL_STYLE = { width: `${CELL_SIZE}px`, height: `${CELL_SIZE}px` }
const SKELETON_STYLE = { height: `${GRAPH_HEIGHT}px` }

// 空档取 --muted，其余四档是 --success 的透明度梯度，深浅色跟随 admin 自己的变量。
const COLOR_SCALE = [
  'hsl(var(--muted))',
  'hsl(var(--success) / 0.3)',
  'hsl(var(--success) / 0.5)',
  'hsl(var(--success) / 0.75)',
  'hsl(var(--success))',
]

const MONTH_NAMES = Array.from({ length: 12 }, (_, month) => `${month + 1} 月`)

const dayFormatter = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' })

function ActivityGraph({ activity }: { activity: SpendActivity }) {
  return (
    <div className="overflow-x-auto">
      <HeatGraph.Root
        // 末尾月份标签压在最后一列之上，右侧不留白就会被容器裁掉。
        className="w-max pr-6"
        data={activity.days}
        start={activity.from}
        end={activity.to}
        weekStart="monday"
        colorScale={COLOR_SCALE}
      >
        <div className="relative text-[10px] text-muted-foreground" style={MONTH_ROW_STYLE}>
          <HeatGraph.MonthLabels>
            {({ label }) => (
              <span
                className="absolute top-0 whitespace-nowrap"
                style={{ left: `${label.column * CELL_PITCH}px` }}
              >
                {MONTH_NAMES[label.month]}
              </span>
            )}
          </HeatGraph.MonthLabels>
        </div>
        <HeatGraph.Grid role="img" aria-label="活跃热力图" style={GRID_STYLE}>
          {() => <HeatGraph.Cell className="rounded-[2px]" style={CELL_STYLE} />}
        </HeatGraph.Grid>
        <HeatGraph.Tooltip className="pointer-events-none rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md">
          {({ cell }) => `${dayFormatter.format(cell.date)} · ${credits(cell.count)} 积分`}
        </HeatGraph.Tooltip>
      </HeatGraph.Root>
    </div>
  )
}

function ActivityHeatGraph({ path }: { path: string }) {
  const query = useQuery({
    queryKey: ['private-billing', 'activity', path],
    queryFn: () => apiClient.get<SpendActivity>(path),
  })
  return (
    <Section title="活跃">
      {query.isPending ? (
        <div className="animate-pulse rounded-md bg-muted" style={SKELETON_STYLE} />
      ) : query.isError ? (
        <p className="flex items-center gap-2 text-sm text-destructive">
          活跃数据读取失败
          <button
            type="button"
            className="text-xs underline underline-offset-2"
            onClick={() => void query.refetch()}
          >
            重试
          </button>
        </p>
      ) : (
        <ActivityGraph activity={query.data} />
      )}
    </Section>
  )
}

export { ActivityGraph, ActivityHeatGraph }
