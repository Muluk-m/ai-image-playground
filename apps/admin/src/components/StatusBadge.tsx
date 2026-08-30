import { Badge } from '@/components/ui/badge'
import type { TaskStatus } from '@/lib/types'

interface StatusBadgeProps {
  status: TaskStatus
}

export function StatusBadge({ status }: StatusBadgeProps) {
  switch (status) {
    case 'completed':
      return <Badge variant="success">成功</Badge>
    case 'failed':
      return <Badge variant="destructive">失败</Badge>
    case 'in_progress':
      return <Badge variant="info">运行中</Badge>
    case 'queued':
      return <Badge variant="warning">排队中</Badge>
    case 'cancelled':
      return <Badge variant="outline">已取消</Badge>
  }
}
