import { Link } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useRef } from 'react'

import { FuzzyTime } from '@/components/FuzzyTime'
import { ModelChips } from '@/components/ModelChips'
import { ShortId } from '@/components/ShortId'
import type { DeviceRow, Range } from '@/lib/types'

interface DeviceTableProps {
  devices: DeviceRow[]
  range: Range
}

const ROW_HEIGHT = 52

export function DeviceTable({ devices, range }: DeviceTableProps) {
  const parentRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: devices.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })

  if (!devices.length) {
    return (
      <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
        近 {range} 内无设备活跃
      </div>
    )
  }

  const virtualItems = rowVirtualizer.getVirtualItems()

  return (
    <div className="rounded-lg border bg-card">
      {/* 表头：与行用同一套列宽 class 对齐 */}
      <div className="flex items-center gap-3 border-b px-4 py-2 text-xs font-medium text-muted-foreground">
        <div className="w-[150px] shrink-0">Device</div>
        <div className="w-[120px] shrink-0">首次出现</div>
        <div className="w-[120px] shrink-0">最近活跃</div>
        <div className="w-[150px] shrink-0">今日任务</div>
        <div className="w-[80px] shrink-0 text-right">范围总数</div>
        <div className="w-[110px] shrink-0 text-right">成功 / 失败</div>
        <div className="min-w-0 flex-1">模型</div>
      </div>

      <div ref={parentRef} className="max-h-[calc(100vh-260px)] min-h-[200px] overflow-auto">
        <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualItems.map((vi) => {
            const d = devices[vi.index]
            if (!d) return null
            return (
              <div
                key={d.device_id}
                className="group absolute left-0 top-0 flex w-full items-center gap-3 border-b px-4 text-sm hover:bg-muted/40"
                style={{ height: ROW_HEIGHT, transform: `translateY(${vi.start}px)` }}
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
                  <span className="font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                    {d.ok_count}
                  </span>
                  <span className="px-1 text-muted-foreground">/</span>
                  <span className="font-mono tabular-nums text-rose-700 dark:text-rose-400">
                    {d.fail_count}
                  </span>
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
