import { createFileRoute, Link } from '@tanstack/react-router'
import { useState } from 'react'

import { ClientErrorTrendChart } from '@/components/ClientErrorTrendChart'
import { FuzzyTime } from '@/components/FuzzyTime'
import { Kpi } from '@/components/Kpi'
import { EmptyState, ErrorState, Page, PendingState } from '@/components/Page'
import { RangeToggle } from '@/components/RangeToggle'
import { ShortId } from '@/components/ShortId'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { isoTime } from '@/lib/format'
import { useClientErrorEvents, useClientErrors } from '@/lib/queries'
import { parseOverviewSearch, RANGE_LABEL, type Range } from '@/lib/search-params'
import type { ClientErrorEvent, ClientErrorGroup, ClientErrorKind } from '@/lib/types'
import { useRangeSearch } from '@/lib/useRangeSearch'

export const Route = createFileRoute('/_authed/errors')({
  validateSearch: parseOverviewSearch,
  component: ClientErrorsPage,
})

const KIND_LABEL: Record<ClientErrorKind, string> = {
  boot: '启动失败',
  error: '运行异常',
  rejection: '未处理 Promise',
  react: '渲染崩溃',
}

/** 启动失败的 message 是守卫记下的原因。 */
const BOOT_REASON_LABEL: Record<string, string> = {
  timeout: '30 秒内没渲染出界面',
  resource: '脚本或样式加载失败',
  preload: '分片加载连续失败',
}

function KindBadge({ kind }: { kind: ClientErrorKind }) {
  return (
    <Badge variant={kind === 'boot' || kind === 'react' ? 'destructive' : 'warning'}>
      {KIND_LABEL[kind] ?? kind}
    </Badge>
  )
}

function title(group: Pick<ClientErrorGroup, 'kind' | 'name' | 'message'>): string {
  // message 是浏览器报上来的，`__proto__` 之类会命中原型链，只认自有键。
  if (group.kind === 'boot') {
    return Object.prototype.hasOwnProperty.call(BOOT_REASON_LABEL, group.message)
      ? BOOT_REASON_LABEL[group.message]!
      : group.message
  }
  return group.name ? `${group.name}: ${group.message}` : group.message
}

function ClientErrorsPage() {
  const [range, setRange] = useRangeSearch()
  const [selectedFingerprint, setSelectedFingerprint] = useState<string | undefined>()
  const query = useClientErrors(range)
  // 只记指纹，分组从当前数据里取：列表刷新、切时间窗后抽屉里的数字跟着走；
  // 新窗口里没有这一组就收起抽屉。
  const selected = query.data?.groups.find((group) => group.fingerprint === selectedFingerprint)

  return (
    <Page
      crumbs={[{ label: '前端错误' }]}
      description="浏览器上报的启动失败与运行期异常，按指纹聚合，保留 30 天；每分钟刷新"
      actions={<RangeToggle value={range} onChange={setRange} />}
    >
      {query.isPending ? (
        <PendingState label="正在汇总前端错误" />
      ) : query.isError ? (
        <ErrorState label="前端错误加载失败" error={query.error} />
      ) : (
        <>
          <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4" aria-label="关键指标">
            <Kpi
              label={`错误次数 · ${RANGE_LABEL[range]}`}
              value={String(query.data.summary.events)}
            />
            <Kpi
              label="启动失败"
              value={String(query.data.summary.boot_events)}
              note="用户看到「工作台暂时无法打开」"
              tone={query.data.summary.boot_events > 0 ? 'danger' : 'default'}
            />
            <Kpi label="影响设备" value={String(query.data.summary.devices)} />
            <Kpi label="问题数" value={String(query.data.summary.groups)} note="按指纹去重" />
          </section>

          <Card>
            <CardHeader className="p-4">
              <CardTitle className="text-sm">趋势 · {RANGE_LABEL[range]}</CardTitle>
            </CardHeader>
            <CardContent className="p-4 pt-0">
              <ClientErrorTrendChart
                buckets={query.data.trend}
                bucketUnit={query.data.bucket_unit}
              />
            </CardContent>
          </Card>

          {query.data.groups.length === 0 ? (
            <EmptyState label="这段时间没有前端错误上报" />
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-28">类型</TableHead>
                    <TableHead>问题</TableHead>
                    <TableHead className="text-right">次数</TableHead>
                    <TableHead className="text-right">设备</TableHead>
                    <TableHead className="hidden lg:table-cell">最近版本</TableHead>
                    <TableHead className="text-right">最近</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {query.data.groups.map((group) => (
                    <TableRow
                      key={group.fingerprint}
                      className="cursor-pointer"
                      onClick={() => setSelectedFingerprint(group.fingerprint)}
                    >
                      <TableCell>
                        <KindBadge kind={group.kind} />
                      </TableCell>
                      <TableCell className="max-w-[min(560px,50vw)]">
                        {/* 整行可点只是鼠标的捷径；键盘用户靠这个按钮打开明细。 */}
                        <button
                          type="button"
                          className="block w-full truncate text-left font-mono text-xs underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
                          title={title(group)}
                          onClick={(event) => {
                            event.stopPropagation()
                            setSelectedFingerprint(group.fingerprint)
                          }}
                        >
                          {title(group)}
                        </button>
                        {group.last_url ? (
                          <p className="truncate text-xs text-muted-foreground">{group.last_url}</p>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {group.count}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {group.devices}
                      </TableCell>
                      <TableCell className="hidden font-mono text-xs lg:table-cell">
                        {group.last_release ?? '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        <FuzzyTime ts={group.last_seen} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </>
      )}

      <Sheet
        open={!!selected}
        onOpenChange={(open) => (open ? null : setSelectedFingerprint(undefined))}
      >
        <SheetContent className="flex w-full flex-col gap-4 overflow-y-auto sm:max-w-3xl">
          <SheetHeader>
            <SheetTitle className="break-all pr-6 text-base">
              {selected ? title(selected) : ''}
            </SheetTitle>
          </SheetHeader>
          {selected ? <GroupDetail group={selected} range={range} /> : null}
        </SheetContent>
      </Sheet>
    </Page>
  )
}

function GroupDetail({ group, range }: { group: ClientErrorGroup; range: Range }) {
  const query = useClientErrorEvents(group.fingerprint, range)
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi variant="inline" label="次数" value={String(group.count)} />
        <Kpi variant="inline" label="设备" value={String(group.devices)} />
        <Kpi variant="inline" label="登录用户" value={String(group.users)} />
        <Kpi variant="inline" label="窗口内首次" value={isoTime(group.first_seen).slice(5, 16)} />
      </div>
      {query.isPending ? (
        <PendingState label="正在加载最近的上报" />
      ) : query.isError ? (
        <ErrorState label="上报明细加载失败" error={query.error} />
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            最近 {query.data.events.length} 次上报（最多 50 次）
          </p>
          {query.data.events.map((event) => (
            <EventCard key={event.id} event={event} />
          ))}
        </div>
      )}
    </div>
  )
}

function EventCard({ event }: { event: ClientErrorEvent }) {
  const context = event.context && Object.keys(event.context).length > 0 ? event.context : null
  return (
    <div className="space-y-2 rounded-md border p-3 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
        <span className="font-mono">{isoTime(event.received_at)}</span>
        {event.release ? <span className="font-mono">版本 {event.release}</span> : null}
        {event.device_id ? (
          <Link
            to="/devices/$deviceId"
            params={{ deviceId: event.device_id }}
            className="underline-offset-2 hover:underline"
          >
            设备 <ShortId value={event.device_id} />
          </Link>
        ) : null}
        {event.user_id ? (
          <Link
            to="/users/$userId"
            params={{ userId: event.user_id }}
            className="underline-offset-2 hover:underline"
          >
            用户 <ShortId value={event.user_id} />
          </Link>
        ) : null}
      </div>
      {event.kind !== 'boot' ? (
        <p className="break-all font-mono">
          {event.name ? `${event.name}: ` : ''}
          {event.message}
        </p>
      ) : null}
      {event.url ? <p className="break-all text-muted-foreground">{event.url}</p> : null}
      {event.user_agent ? (
        <p className="break-all text-muted-foreground">{event.user_agent}</p>
      ) : null}
      {event.stack ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-[11px]">
          {event.stack}
        </pre>
      ) : null}
      {context ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-[11px]">
          {JSON.stringify(context, null, 2)}
        </pre>
      ) : null}
    </div>
  )
}
