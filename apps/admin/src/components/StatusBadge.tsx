import { Badge } from '@/components/ui/badge'
import type { TaskStatus } from '@/lib/types'

// 接 string 是因为 server 字段是 TEXT；当传入值落在 TaskStatus 已知集合内时
// 走对应文案，否则 fallback 显示原字符串（防止 server 新增 status 时 UI 静默）
interface StatusBadgeProps {
  status: TaskStatus | string
}

export function StatusBadge({ status }: StatusBadgeProps) {
  switch (status as TaskStatus) {
    case 'completed':
    case 'succeeded':
      return <Badge variant="success">成功</Badge>
    case 'failed':
      return <Badge variant="destructive">失败</Badge>
    case 'in_progress':
    case 'running':
      return <Badge variant="info">运行中</Badge>
    case 'queued':
      return <Badge variant="warning">排队中</Badge>
    case 'interrupted':
      return <Badge variant="outline">已中断</Badge>
    default:
      return <Badge variant="outline">{status}</Badge>
  }
}
