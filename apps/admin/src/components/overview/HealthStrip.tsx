import { Link } from '@tanstack/react-router'

import { type HealthTile, signalSearch, type Tone } from '@/lib/overview-signals'
import type { Range } from '@/lib/search-params'
import { cn } from '@/lib/utils'

const STRIPE: Record<Tone, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  bad: 'bg-danger',
  unknown: 'bg-muted-foreground/40',
}

const STATE_LABEL: Record<Tone, string> = {
  ok: '正常',
  warn: '注意',
  bad: '异常',
  unknown: '未知',
}

/** 每个子系统一盏灯：左侧色条是状态，数字是这一项最该看的那个读数，点进去是详情页。 */
export function HealthStrip({ tiles, range }: { tiles: readonly HealthTile[]; range: Range }) {
  return (
    <section aria-label="系统健康" className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
      {tiles.map((tile) => (
        <Link
          key={tile.key}
          to={tile.to}
          search={signalSearch(tile.to, range) as never}
          aria-label={`${tile.label}：${STATE_LABEL[tile.tone]}，${tile.value}`}
          className={cn(
            'group relative flex min-w-0 flex-col gap-0.5 overflow-hidden rounded-lg border bg-card py-2.5 pl-4 pr-3 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            tile.tone === 'bad' && 'border-danger/40',
            tile.tone === 'warn' && 'border-warning/40',
          )}
        >
          <span className={cn('absolute inset-y-0 left-0 w-1', STRIPE[tile.tone])} />
          <span className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            {tile.label}
          </span>
          <span
            className={cn(
              'font-mono text-lg font-semibold tabular-nums',
              tile.tone === 'bad' && 'text-danger',
              tile.tone === 'warn' && 'text-warning',
            )}
          >
            {tile.value}
          </span>
          <span
            className="line-clamp-2 text-[11px] leading-snug text-muted-foreground"
            title={tile.note}
          >
            {tile.note}
          </span>
        </Link>
      ))}
    </section>
  )
}
