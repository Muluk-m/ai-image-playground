import type { ReactNode } from 'react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { OpsBlock } from '@/lib/types'
import { cn } from '@/lib/utils'

interface OpsBlockCardProps<T> {
  title: string
  block: OpsBlock<T>
  /** 这一块此刻要运营者处理的事；没有就是健康。 */
  problems: (data: T) => string[]
  children: (data: T) => ReactNode
  className?: string
}

/**
 * 看板的一栏。每一栏独立取、独立失败：取不到时只有这一栏说取不到，别的栏照常。
 * 有问题时整栏描红并把问题写成一句话放在最上面——运营者打开看板是来找红色的。
 * 问题列表刻意不是 live region：句子里带着会走的数字，看板每 30 秒刷新一次，读屏会把同一件事
 * 从头到尾念一整场事故。
 */
export function OpsBlockCard<T>({
  title,
  block,
  problems,
  children,
  className,
}: OpsBlockCardProps<T>) {
  const issues = block.ok ? problems(block.data) : []
  return (
    <Card
      role="region"
      aria-label={title}
      className={cn(
        'overflow-hidden bg-card shadow-sm',
        issues.length > 0 && 'border-danger/60',
        !block.ok && 'border-dashed',
        className,
      )}
    >
      <CardHeader className="flex-row items-center justify-between gap-3 border-b bg-muted/15 px-5 py-4">
        <CardTitle className="text-sm">{title}</CardTitle>
        <span
          className={cn(
            'flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px]',
            !block.ok
              ? 'bg-muted text-muted-foreground'
              : issues.length
                ? 'bg-danger/10 text-danger'
                : 'bg-success/10 text-success',
          )}
        >
          <span className="size-1.5 rounded-full bg-current" />
          {!block.ok ? '读取失败' : issues.length ? `${issues.length} 项需处理` : '未触发告警'}
        </span>
      </CardHeader>
      <CardContent className="space-y-4 p-5">
        {!block.ok ? (
          <div>
            <p className="text-sm font-medium text-muted-foreground">取不到</p>
            <p className="mt-1 break-words font-mono text-xs text-muted-foreground">
              {block.error}
            </p>
          </div>
        ) : (
          <>
            {issues.length > 0 ? (
              <ul aria-label="需要处理" className="space-y-1 text-sm font-medium text-danger">
                {issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            ) : null}
            {children(block.data)}
          </>
        )}
      </CardContent>
    </Card>
  )
}
