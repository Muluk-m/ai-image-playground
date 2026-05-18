import { Link } from '@tanstack/react-router'

import { FuzzyTime } from '@/components/FuzzyTime'
import { ModelChips } from '@/components/ModelChips'
import { ShortId } from '@/components/ShortId'
import { Progress } from '@/components/ui/progress'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { DAILY_QUOTA_LIMIT, type DeviceRow, type Range } from '@/lib/types'

interface DeviceTableProps {
  devices: DeviceRow[]
  range: Range
}

export function DeviceTable({ devices, range }: DeviceTableProps) {
  if (!devices.length) {
    return (
      <div className="rounded-lg border bg-card p-12 text-center text-sm text-muted-foreground">
        近 {range} 内无设备活跃
      </div>
    )
  }
  return (
    <div className="rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Device</TableHead>
            <TableHead>首次出现</TableHead>
            <TableHead>最近活跃</TableHead>
            <TableHead>今日</TableHead>
            <TableHead className="text-right">范围总数</TableHead>
            <TableHead className="text-right">成功 / 失败</TableHead>
            <TableHead>模型</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {devices.map((d) => (
            <DeviceRowItem key={d.device_id} d={d} />
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function DeviceRowItem({ d }: { d: DeviceRow }) {
  const pct = Math.min(100, Math.round((d.today_count / DAILY_QUOTA_LIMIT) * 100))
  return (
    <TableRow className="group">
      <TableCell>
        <Link to="/devices/$deviceId" params={{ deviceId: d.device_id }} className="block">
          <ShortId value={d.device_id} />
        </Link>
      </TableCell>
      <TableCell>
        <FuzzyTime ts={d.first_seen} />
      </TableCell>
      <TableCell>
        <FuzzyTime ts={d.last_seen} />
      </TableCell>
      <TableCell>
        <div className="flex w-32 items-center gap-2">
          <span className="w-12 shrink-0 font-mono text-xs tabular-nums">
            {d.today_count} / {DAILY_QUOTA_LIMIT}
          </span>
          <Progress value={pct} className="h-1.5 flex-1" />
        </div>
      </TableCell>
      <TableCell className="text-right font-mono tabular-nums">{d.total}</TableCell>
      <TableCell className="text-right">
        <span className="font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
          {d.ok_count}
        </span>
        <span className="px-1 text-muted-foreground">/</span>
        <span className="font-mono tabular-nums text-rose-700 dark:text-rose-400">
          {d.fail_count}
        </span>
      </TableCell>
      <TableCell>
        <ModelChips models={d.models} />
      </TableCell>
    </TableRow>
  )
}
