import type { SpendActivity } from '@image-playground/shared'
import * as HeatGraph from 'heat-graph'
import type { ReactNode } from 'react'
import { Button, currentLocale, formatDate, isClientCapabilityEnabled } from '../../lib/privateHost'
import { formatCredits, useSpendActivity } from './billing-store'
import { tBilling, useTranslation } from './i18n'

const GAP_PX = 4

/** 空档使用 muted，其余按 primary 的强度区分消费量，随主题切换。 */
const COLORS = [
  'hsl(var(--muted))',
  'hsl(var(--primary) / .25)',
  'hsl(var(--primary) / .45)',
  'hsl(var(--primary) / .7)',
  'hsl(var(--primary))',
]

/** 只标周一、三、五、日，其余留白，和 GitHub 的贡献图一样。 */
const LABELLED_WEEKDAYS = new Set([0, 1, 3, 5])

/** 星期与月份名交给 Intl 按当前语言生成，语料里不手写十二个月份。 */
function weekdayLabel(dayOfWeek: number): string {
  if (!LABELLED_WEEKDAYS.has(dayOfWeek)) return ''
  // 2024-01-07 是周日，加上 dayOfWeek 天正好落到目标星期。
  const day = new Date(Date.UTC(2024, 0, 7 + dayOfWeek))
  return new Intl.DateTimeFormat(currentLocale(), {
    weekday: 'narrow',
    timeZone: 'UTC',
  }).format(day)
}

function monthLabel(month: number): string {
  return new Intl.DateTimeFormat(currentLocale(), { month: 'short', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2024, month, 1)),
  )
}

function Section({ total, children }: { total: number | null; children: ReactNode }) {
  useTranslation()
  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">{tBilling('activity.title')}</h3>
        {total === null ? null : (
          <span className="text-xs text-muted-foreground">
            {tBilling('activity.yearTotal', { count: total, n: formatCredits(total) })}
          </span>
        )}
      </div>
      {children}
    </section>
  )
}

export function SpendHeatGraph({ activity, total }: { activity: SpendActivity; total: number }) {
  useTranslation()
  const firstDay = new Date(activity.from)
  const leadingDays = (firstDay.getUTCDay() + 6) % 7
  const days = (Date.parse(activity.to) - firstDay.getTime()) / 86_400_000 + 1
  const weeks = Math.ceil((days + leadingDays) / 7)
  return (
    <Section total={total}>
      <HeatGraph.Root
        data={activity.days}
        start={activity.from}
        end={activity.to}
        weekStart="monday"
        colorScale={COLORS}
        className="relative"
      >
        {/* 宽屏完整显示全年；窄屏从最近日期开始滚动，避免把有消费的末尾几周藏起来。 */}
        <div dir="rtl" className="overflow-x-auto pb-1">
          <div
            dir="ltr"
            className="grid w-full min-w-[640px] gap-x-1.5 gap-y-1 pr-6"
            style={{ gridTemplateColumns: '24px minmax(0, 1fr)' }}
          >
            <div className="relative col-start-2 row-start-1 h-3.5 text-label-sm text-muted-foreground">
              <HeatGraph.MonthLabels>
                {({ label }) => (
                  <span
                    className="absolute top-0 whitespace-nowrap"
                    style={{
                      left: `calc(${(label.column / weeks) * 100}% + ${(label.column / weeks) * GAP_PX}px)`,
                    }}
                  >
                    {monthLabel(label.month)}
                  </span>
                )}
              </HeatGraph.MonthLabels>
            </div>
            <div
              className="col-start-1 row-start-2 grid items-center text-label-sm leading-none text-muted-foreground"
              style={{ gridTemplateRows: 'repeat(7, 1fr)', rowGap: GAP_PX }}
            >
              <HeatGraph.DayLabels>
                {({ label }) => <span>{weekdayLabel(label.dayOfWeek)}</span>}
              </HeatGraph.DayLabels>
            </div>
            <HeatGraph.Grid
              role="img"
              aria-label={tBilling('activity.graphAria')}
              className="col-start-2 row-start-2"
              style={{
                gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))`,
                gap: GAP_PX,
              }}
            >
              {() => <HeatGraph.Cell className="aspect-square rounded-sm" />}
            </HeatGraph.Grid>
          </div>
        </div>
        <HeatGraph.Tooltip className="pointer-events-none z-10 rounded-md bg-card px-2 py-1 text-label-sm tabular-nums text-foreground">
          {({ cell }) =>
            `${formatDate(cell.date)} · ${
              cell.count > 0
                ? tBilling('activity.tooltipCredits', {
                    count: cell.count,
                    n: formatCredits(cell.count),
                  })
                : tBilling('activity.tooltipNone')
            }`
          }
        </HeatGraph.Tooltip>
        <div className="mt-1.5 flex items-center justify-end gap-1 text-label-sm text-muted-foreground">
          <span>{tBilling('activity.less')}</span>
          {COLORS.map((color) => (
            <span
              key={color}
              className="h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: color }}
            />
          ))}
          <span>{tBilling('activity.more')}</span>
        </div>
      </HeatGraph.Root>
    </Section>
  )
}

function ActivityBody() {
  useTranslation()
  const { snapshot, retry } = useSpendActivity()

  if (snapshot.status === 'loading') {
    return (
      <Section total={null}>
        <div className="h-32 animate-pulse rounded-2xl bg-muted" />
      </Section>
    )
  }
  if (snapshot.status === 'error' || !snapshot.activity) {
    return (
      <Section total={null}>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          {tBilling('activity.loadFailed')}
          <Button variant="outline" size="xs" type="button" onClick={retry}>
            {tBilling('action.retry')}
          </Button>
        </div>
      </Section>
    )
  }
  return <SpendHeatGraph activity={snapshot.activity} total={snapshot.total} />
}

export function ActivitySection() {
  // 门禁必须在 ActivityBody 之外：关掉时连它的 fetch effect 都不该挂载。
  if (!isClientCapabilityEnabled('billing:credits')) return null
  return <ActivityBody />
}
