import { Link } from '@tanstack/react-router'
import { ErrorState, PendingState } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useTodayErrors } from '@/lib/queries'

export function TodayErrorsCard() {
  const query = useTodayErrors()
  return (
    <Card className="min-w-0">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0 p-4">
        <CardTitle className="text-sm">
          错误日志 · 今天{query.data ? ` · ${query.data.total} 条` : ''}
        </CardTitle>
        <Link
          to="/logs"
          search={{ ...query.data?.window, level: 'error' }}
          className="text-xs text-success hover:underline"
        >
          服务端日志 →
        </Link>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0">
        {query.data ? (
          <>
            {query.isError ? (
              <p role="status" className="text-xs text-danger">
                错误日志刷新失败，下面是之前的记录。
              </p>
            ) : null}
            {query.data.entries.length ? (
              <div
                role="log"
                aria-label="今日错误终端"
                className="max-h-96 overflow-auto rounded-md bg-muted/30 p-3 font-mono text-xs"
              >
                {query.data.entries.map((entry) => (
                  <div className="mb-4 last:mb-0" key={`${entry.source}:${entry.id}`}>
                    <div className="flex items-baseline gap-2 text-muted-foreground">
                      <time dateTime={new Date(entry.at).toISOString()}>
                        {new Date(entry.at).toLocaleTimeString('zh-CN', {
                          timeZone: 'Asia/Shanghai',
                          hour12: false,
                        })}
                      </time>
                      <span className="text-danger">{entry.service}</span>
                    </div>
                    <pre className="whitespace-pre leading-5">
                      {entry.message}
                      {entry.stack && !entry.message.includes(entry.stack)
                        ? `\n${entry.stack}`
                        : ''}
                    </pre>
                    <div className="mt-1 text-xs">
                      <div className="flex flex-wrap gap-2">
                        {entry.task_id ? (
                          <Button size="sm" variant="outline" asChild>
                            <Link
                              to="/tasks"
                              search={{ ...query.data!.window, task: entry.task_id }}
                            >
                              关联任务 →
                            </Link>
                          </Button>
                        ) : null}
                        {entry.source === 'server' ? (
                          <Button size="sm" variant="outline" asChild>
                            <Link
                              to="/logs"
                              search={{
                                from:
                                  entry.request_id || !entry.instance
                                    ? query.data!.window.from
                                    : Math.max(query.data!.window.from, entry.at - 60_000),
                                to:
                                  entry.request_id || !entry.instance
                                    ? query.data!.window.to
                                    : Math.min(query.data!.window.to, entry.at + 60_000),
                                instance: entry.request_id
                                  ? undefined
                                  : (entry.instance ?? undefined),
                                group:
                                  entry.request_id || entry.instance
                                    ? undefined
                                    : (entry.group ?? undefined),
                                requestId: entry.request_id ?? undefined,
                              }}
                            >
                              相关日志 →
                            </Link>
                          </Button>
                        ) : (
                          <Link
                            to="/errors"
                            search={{ range: '1d' }}
                            className="text-success hover:underline"
                          >
                            前端错误页（近 24 小时）→
                          </Link>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">
                今天没有采集到错误日志
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              服务端 ERROR / FATAL 与浏览器异常 · 最近 10 条 · 每 30 秒刷新
            </p>
          </>
        ) : query.isError ? (
          <ErrorState label="错误日志加载失败" error={query.error} />
        ) : (
          <PendingState label="正在读取错误日志" />
        )}
        <div className="flex flex-wrap gap-4 border-t pt-3 text-xs">
          <Link
            to="/logs"
            search={{ ...query.data?.window, level: 'fatal' }}
            className="text-success hover:underline"
          >
            致命日志 →
          </Link>
          <Link to="/errors" search={{ range: '1d' }} className="text-success hover:underline">
            前端错误（近 24 小时）→
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}
