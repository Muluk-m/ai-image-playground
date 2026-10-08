import { Link } from '@tanstack/react-router'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { operationHealthTiles, type Tone } from '@/lib/overview-signals'
import { useOps } from '@/lib/queries'
import { DEFAULT_OPS_RANGE } from '@/lib/search-params'
import { cn } from '@/lib/utils'

const STATE: Record<Tone, string> = { ok: '正常', bad: '异常', warn: '注意', unknown: '未知' }
const COLOR: Record<Tone, string> = {
  ok: 'bg-success',
  bad: 'bg-danger',
  warn: 'bg-warning',
  unknown: 'bg-muted-foreground/50',
}

export function OpsHealthCard() {
  const query = useOps(DEFAULT_OPS_RANGE)
  const tiles = operationHealthTiles(query.data, query.isError ? 'failed' : 'loading').filter(
    (tile) => tile.key !== 'backup',
  )
  return (
    <Card className="min-w-0">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0 p-4">
        <CardTitle className="text-sm">服务健康 · 当前</CardTitle>
        <Link to="/ops" className="text-xs text-success hover:underline">
          运维详情 →
        </Link>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0">
        {query.isError && query.data ? (
          <p role="status" className="text-xs text-danger">
            刷新失败，下面是之前的快照。
          </p>
        ) : null}
        <section aria-label="服务健康" className="grid grid-cols-2 gap-4">
          {tiles.map((tile) => (
            <Link
              key={tile.key}
              to="/ops"
              aria-label={`${tile.label}：${STATE[tile.tone]}，${tile.value}`}
              className="min-w-0 rounded-md p-2 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className={cn('size-2 rounded-full', COLOR[tile.tone])} />
                {tile.label} · {STATE[tile.tone]}
              </span>
              <p
                className={cn(
                  'mt-1 font-mono text-sm font-semibold',
                  tile.tone === 'bad' && 'text-danger',
                )}
              >
                {tile.value}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{tile.note}</p>
            </Link>
          ))}
        </section>
        {query.data ? (
          <p className="border-t pt-3 text-xs text-muted-foreground">
            快照{' '}
            {new Date(query.data.generated_at).toLocaleString('zh-CN', {
              timeZone: 'Asia/Shanghai',
              hour12: false,
            })}{' '}
            · 每 30 秒刷新
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}
