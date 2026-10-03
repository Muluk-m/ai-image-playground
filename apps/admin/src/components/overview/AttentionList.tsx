import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'

import type { AttentionItem } from '@/lib/overview-signals'
import { cn } from '@/lib/utils'

function Row({ item }: { item: AttentionItem }) {
  const body = (
    <>
      <span
        className={cn(
          'shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold',
          item.tone === 'bad' ? 'bg-danger/10 text-danger' : 'bg-warning/15 text-warning',
        )}
      >
        {item.source}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block break-words text-sm">{item.title}</span>
        {item.detail ? (
          <span className="block text-xs text-muted-foreground">{item.detail}</span>
        ) : null}
      </span>
      {item.to ? <ChevronRight className="size-4 shrink-0 text-muted-foreground" /> : null}
    </>
  )
  const className = 'flex items-start gap-3 rounded-md bg-muted/60 px-3 py-2'
  return item.to ? (
    <Link to={item.to} className={cn(className, 'transition-colors hover:bg-muted')}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  )
}

/** 跨来源汇总要人处理的事；没有就明说没有，不留一块空白让人猜。 */
export function AttentionList({
  items,
  pending,
}: {
  items: readonly AttentionItem[]
  pending: boolean
}) {
  if (!items.length) {
    return (
      <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <span className="size-2 rounded-full bg-success" />
        {pending ? '运维数据还在读取，目前没发现问题' : '没有需要处理的事'}
      </p>
    )
  }
  return (
    <ul className="grid gap-2" aria-label="需要处理">
      {items.map((item) => (
        <li key={item.key}>
          <Row item={item} />
        </li>
      ))}
    </ul>
  )
}
