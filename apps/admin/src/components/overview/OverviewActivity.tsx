import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { StatusBadge } from '@/components/StatusBadge'
import { Button } from '@/components/ui/button'
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
import { shortId } from '@/lib/format'
import type {
  OverviewActivityResult,
  OverviewClientError,
  OverviewServerError,
} from '../../../contracts'

type SelectedError =
  | { source: 'client'; entry: OverviewClientError }
  | { source: 'server'; entry: OverviewServerError }

function time(at: number): string {
  return new Date(at).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

export function OverviewActivity({ data }: { data: OverviewActivityResult }) {
  const [selected, setSelected] = useState<SelectedError | null>(null)
  const window = data.window
  return (
    <>
      <section className="grid items-start gap-4 xl:grid-cols-2" aria-label="错误日志">
        <Card className="min-w-0">
          <CardHeader className="flex-row items-center justify-between space-y-0 p-4">
            <CardTitle className="text-sm">前端错误 · {data.client.total}</CardTitle>
            <span className="text-xs text-muted-foreground">最近 5 条</span>
          </CardHeader>
          <CardContent className="p-0">
            {data.client.entries.length ? (
              <ul className="divide-y">
                {data.client.entries.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className="block w-full space-y-1 px-4 py-3 text-left hover:bg-muted/50"
                      onClick={() => setSelected({ source: 'client', entry })}
                    >
                      <p className="line-clamp-2 break-all text-sm text-danger">{entry.message}</p>
                      <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                        <time dateTime={new Date(entry.at).toISOString()}>{time(entry.at)}</time>
                        <span>
                          {entry.username ??
                            (entry.device_id ? `设备 ${shortId(entry.device_id)}` : '未关联用户')}
                        </span>
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-6 text-sm text-muted-foreground">所选时间内没有前端错误</p>
            )}
          </CardContent>
        </Card>
        <Card className="min-w-0">
          <CardHeader className="flex-row items-center justify-between space-y-0 p-4">
            <CardTitle className="text-sm">后端错误日志 · {data.server.total}</CardTitle>
            <span className="text-xs text-muted-foreground">最近 5 条 · 保留 7 天</span>
          </CardHeader>
          <CardContent className="p-0">
            {data.server.entries.length ? (
              <ul className="divide-y">
                {data.server.entries.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className="block w-full space-y-1 px-4 py-3 text-left hover:bg-muted/50"
                      onClick={() => setSelected({ source: 'server', entry })}
                    >
                      <p className="line-clamp-2 break-all text-sm text-danger">{entry.message}</p>
                      <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                        <time dateTime={new Date(entry.at).toISOString()}>{time(entry.at)}</time>
                        <span>{entry.service}</span>
                        {entry.task_id ? (
                          <span className="font-mono">任务 {shortId(entry.task_id)}</span>
                        ) : null}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-6 text-sm text-muted-foreground">所选时间内没有后端错误日志</p>
            )}
          </CardContent>
        </Card>
      </section>
      <Card className="min-w-0">
        <CardHeader className="flex-row items-center justify-between space-y-0 p-4">
          <CardTitle className="text-sm">最近生成任务</CardTitle>
          <Link to="/tasks" search={window} className="text-xs text-success hover:underline">
            全部任务 →
          </Link>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {data.tasks.length ? (
            <Table className="min-w-[640px]" aria-label="最近生成任务">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">提交时间</TableHead>
                  <TableHead>用户</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>需求 / 模型</TableHead>
                  <TableHead className="pr-4">问题</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.tasks.map((task) => (
                  <TableRow key={task.id}>
                    <TableCell className="whitespace-nowrap pl-4 font-mono text-xs">
                      {time(task.submitted_at)}
                    </TableCell>
                    <TableCell className="max-w-48 truncate text-xs">
                      {task.username ??
                        (task.device_id ? `设备 ${shortId(task.device_id)}` : '未关联用户')}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={task.status} />
                    </TableCell>
                    <TableCell className="max-w-80">
                      <Link
                        to="/tasks"
                        search={{ ...window, task: task.id }}
                        className="block truncate text-sm hover:underline"
                      >
                        {task.prompt || shortId(task.id)}
                      </Link>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {task.model}
                      </p>
                    </TableCell>
                    <TableCell className="pr-4 font-mono text-xs text-danger">
                      {task.error_type ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="p-6 text-sm text-muted-foreground">所选时间内没有生成任务</p>
          )}
        </CardContent>
      </Card>
      <Sheet
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
      >
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>
              {selected?.source === 'client' ? '前端错误详情' : '后端错误详情'}
            </SheetTitle>
          </SheetHeader>
          {selected ? (
            <div className="mt-4 space-y-4 text-sm">
              <p className="font-mono text-xs text-muted-foreground">{time(selected.entry.at)}</p>
              <pre className="whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs">
                {selected.entry.message}
                {selected.entry.stack ? `\n${selected.entry.stack}` : ''}
              </pre>
              {selected.source === 'server' ? (
                <div className="space-y-3">
                  <p className="break-all text-xs text-muted-foreground">
                    {selected.entry.service}
                    {selected.entry.instance ? ` · ${selected.entry.instance}` : ''}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" asChild>
                      <Link
                        to="/logs"
                        search={{
                          from: Math.max(0, selected.entry.at - 60_000),
                          to: Math.min(Date.now(), selected.entry.at + 60_000),
                          requestId: selected.entry.request_id ?? undefined,
                          instance: selected.entry.request_id
                            ? undefined
                            : (selected.entry.instance ?? undefined),
                        }}
                      >
                        相关日志 →
                      </Link>
                    </Button>
                    {selected.entry.task_id ? (
                      <Button size="sm" variant="outline" asChild>
                        <Link to="/tasks" search={{ ...window, task: selected.entry.task_id }}>
                          关联任务 →
                        </Link>
                      </Button>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="space-y-2 text-xs text-muted-foreground">
                  <p className="break-all">
                    {selected.entry.username ?? selected.entry.user_id ?? '匿名用户'}
                  </p>
                  {selected.entry.device_id ? (
                    <p className="break-all font-mono">设备 {selected.entry.device_id}</p>
                  ) : null}
                  <p className="break-all font-mono">{selected.entry.fingerprint}</p>
                </div>
              )}
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  )
}
