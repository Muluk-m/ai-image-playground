import { Check, Copy } from 'lucide-react'
import { useState } from 'react'

import { FuzzyTime } from '@/components/FuzzyTime'
import { ModelChips } from '@/components/ModelChips'
import { Button } from '@/components/ui/button'
import { copyText } from '@/lib/format'
import type { DeviceRow, Range } from '@/lib/types'

interface DeviceMetaCardProps {
  device: DeviceRow
  range: Range
  runningCount?: number
}

const RANGE_LABEL: Record<Range, string> = {
  '1d': '近 1 天',
  '7d': '近 7 天',
  '30d': '近 30 天',
}

export function DeviceMetaCard({ device, range, runningCount = 0 }: DeviceMetaCardProps) {
  const [copied, setCopied] = useState(false)

  async function onCopy(): Promise<void> {
    if (await copyText(device.device_id)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    }
  }

  return (
    <div className="rounded-lg border bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            设备
          </h2>
          <div className="mt-1 flex items-center gap-2">
            <span className="font-mono text-base">{device.device_id}</span>
            <Button
              size="icon"
              variant="ghost"
              aria-label="复制 device id"
              onClick={() => {
                void onCopy()
              }}
              className="h-6 w-6"
            >
              {copied ? <Check /> : <Copy />}
            </Button>
          </div>
          <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
            <span>
              首次：
              <FuzzyTime ts={device.first_seen} />
            </span>
            <span>
              最近：
              <FuzzyTime ts={device.last_seen} />
            </span>
          </div>
        </div>

        <div className="min-w-[180px]">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            今日任务
          </h3>
          <div className="mt-1 font-mono text-2xl tabular-nums">{device.today_count}</div>
        </div>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label={`${RANGE_LABEL[range]} 累计`} value={device.total} />
        <Stat label="成功" value={device.ok_count} tone="text-emerald-700 dark:text-emerald-400" />
        <Stat label="失败" value={device.fail_count} tone="text-rose-700 dark:text-rose-400" />
        <Stat label="运行中" value={runningCount} />
      </div>

      <div className="mt-6">
        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          使用过的模型
        </h3>
        <ModelChips models={device.models} max={20} />
      </div>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 font-mono text-xl tabular-nums ${tone ?? ''}`}>{value}</div>
    </div>
  )
}
