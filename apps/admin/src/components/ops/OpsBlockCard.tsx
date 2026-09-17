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
}

/**
 * 看板的一栏。每一栏独立取、独立失败：取不到时只有这一栏说取不到，别的栏照常。
 * 有问题时整栏描红并把问题写成一句话放在最上面——运营者打开看板是来找红色的。
 */
export function OpsBlockCard<T>({ title, block, problems, children }: OpsBlockCardProps<T>) {
  const issues = block.ok ? problems(block.data) : []
  return (
    <Card
      role="region"
      aria-label={title}
      className={cn(issues.length > 0 && 'border-danger/60', !block.ok && 'border-dashed')}
    >
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0">
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
              <ul role="alert" className="space-y-1 text-sm font-medium text-danger">
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
