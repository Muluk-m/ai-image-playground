import { Badge } from '@/components/ui/badge'

interface StatusBadgeProps {
  status: string
}

export function StatusBadge({ status }: StatusBadgeProps) {
  switch (status) {
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
