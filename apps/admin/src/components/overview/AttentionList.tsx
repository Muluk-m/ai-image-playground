import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'

import { type AttentionItem, signalSearch } from '@/lib/overview-signals'
import type { Range } from '@/lib/search-params'
import { cn } from '@/lib/utils'

function Row({ item, range }: { item: AttentionItem; range: Range }) {
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
    <Link
      to={item.to}
      search={signalSearch(item.to, range) as never}
      className={cn(className, 'transition-colors hover:bg-muted')}
    >
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
  range,
}: {
  items: readonly AttentionItem[]
  /** 还有来源没读完：此时列表为空不代表没事。 */
  pending: boolean
  range: Range
}) {
  if (!items.length) {
    return (
      <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <span
          className={cn('size-2 rounded-full', pending ? 'bg-muted-foreground/40' : 'bg-success')}
        />
        {pending ? '还有数据在读取，已读到的部分没发现问题' : '没有需要处理的事'}
      </p>
    )
  }
  return (
    <ul className="grid gap-2" aria-label="需要处理">
      {items.map((item) => (
        <li key={item.key}>
          <Row item={item} range={range} />
        </li>
      ))}
    </ul>
  )
}
