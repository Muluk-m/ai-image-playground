import { Link } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef } from 'react'

import { FuzzyTime } from '@/components/FuzzyTime'
import { ModelChips } from '@/components/ModelChips'
import { EmptyState } from '@/components/Page'
import { ShortId } from '@/components/ShortId'
import { useIsMobile } from '@/hooks/use-mobile'
import { RANGE_LABEL, SORT_LABEL } from '@/lib/search-params'
import type { DeviceRow, Range } from '@/lib/types'

interface DeviceTableProps {
  devices: DeviceRow[]
  range: Range
}

const DESKTOP_ROW_HEIGHT = 52
const MOBILE_ROW_HEIGHT = 132

export function DeviceTable({ devices, range }: DeviceTableProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const isMobile = useIsMobile()
  const rowVirtualizer = useVirtualizer({
    count: devices.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => (isMobile ? MOBILE_ROW_HEIGHT : DESKTOP_ROW_HEIGHT),
    overscan: 12,
  })

  useEffect(() => {
    rowVirtualizer.measure()
  }, [rowVirtualizer, isMobile])
  if (!devices.length) return <EmptyState label={`近 ${RANGE_LABEL[range]} 内无设备活跃`} />

  const virtualItems = rowVirtualizer.getVirtualItems()

  return (
    <div className="rounded-lg border bg-card">
      {/* 表头：与行用同一套列宽 class 对齐 */}
      <div className="hidden items-center gap-3 border-b px-4 py-2 text-xs font-medium text-muted-foreground md:flex">
        <div className="w-[150px] shrink-0">Device</div>
        <div className="w-[120px] shrink-0">首次出现</div>
        <div className="w-[120px] shrink-0">{SORT_LABEL.last_seen}</div>
        <div className="w-[150px] shrink-0">{SORT_LABEL.today_count}</div>
        <div className="w-[80px] shrink-0 text-right">{SORT_LABEL.total_count}</div>
        <div className="w-[110px] shrink-0 text-right">成功 / 失败</div>
        <div className="min-w-0 flex-1">模型</div>
      </div>

      <div ref={parentRef} className="max-h-[calc(100vh-260px)] min-h-[200px] overflow-auto">
        <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualItems.map((vi) => {
            const d = devices[vi.index]
            if (!d) return null
            if (isMobile) {
              return (
                <Link
                  key={d.device_id}
                  to="/devices/$deviceId"
                  params={{ deviceId: d.device_id }}
                  className="group absolute left-0 top-0 flex w-full flex-col gap-2 border-b px-4 py-3 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  style={{ height: MOBILE_ROW_HEIGHT, transform: `translateY(${vi.start}px)` }}
                >
                  <span className="flex min-w-0 items-center justify-between gap-3">
                    <span className="min-w-0 truncate font-mono text-sm font-medium">
                      {d.device_id}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      <FuzzyTime ts={d.last_seen} />
                    </span>
                  </span>
                  <span className="grid grid-cols-4 gap-3 text-xs">
                    <span>
                      <small className="block text-[9px] uppercase text-muted-foreground">
                        今日
                      </small>
                      <strong className="font-mono tabular-nums">{d.today_count}</strong>
                    </span>
                    <span>
                      <small className="block text-[9px] uppercase text-muted-foreground">
                        {RANGE_LABEL[range]}
                      </small>
                      <strong className="font-mono tabular-nums">{d.total}</strong>
                    </span>
                    <span>
                      <small className="block text-[9px] uppercase text-muted-foreground">
                        成功
                      </small>
                      <strong className="font-mono text-success tabular-nums">{d.ok_count}</strong>
                    </span>
                    <span>
                      <small className="block text-[9px] uppercase text-muted-foreground">
                        失败
                      </small>
                      <strong className="font-mono text-danger tabular-nums">{d.fail_count}</strong>
                    </span>
                  </span>
                  <span className="min-w-0 overflow-hidden">
                    <ModelChips models={d.models} max={3} />
                  </span>
                </Link>
              )
            }
            return (
              <div
                key={d.device_id}
                className="group absolute left-0 top-0 flex w-full items-center gap-3 border-b px-4 text-sm hover:bg-muted/40"
                style={{ height: DESKTOP_ROW_HEIGHT, transform: `translateY(${vi.start}px)` }}
              >
                <div className="w-[150px] shrink-0">
                  <Link
                    to="/devices/$deviceId"
                    params={{ deviceId: d.device_id }}
                    className="block"
                  >
                    <ShortId value={d.device_id} />
                  </Link>
                </div>
                <div className="w-[120px] shrink-0">
                  <FuzzyTime ts={d.first_seen} />
                </div>
                <div className="w-[120px] shrink-0">
                  <FuzzyTime ts={d.last_seen} />
                </div>
                <div className="w-[150px] shrink-0 font-mono text-xs tabular-nums">
                  {d.today_count}
                </div>
                <div className="w-[80px] shrink-0 text-right font-mono tabular-nums">{d.total}</div>
                <div className="w-[110px] shrink-0 text-right">
                  <span className="font-mono tabular-nums text-success">{d.ok_count}</span>
                  <span className="px-1 text-muted-foreground">/</span>
                  <span className="font-mono tabular-nums text-danger">{d.fail_count}</span>
                </div>
                <div className="min-w-0 flex-1 overflow-hidden">
                  <ModelChips models={d.models} />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
