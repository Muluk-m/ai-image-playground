import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { ErrorState, PendingState } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useTodayErrors } from '@/lib/queries'
import type { ErrorRecoveryState } from '../../../contracts'

export function TodayErrorsCard() {
  const query = useTodayErrors()
  const [selectedPeriod, setPeriod] = useState<'today' | 'recent'>('today')
  const period = selectedPeriod === 'recent' && query.data?.recent ? 'recent' : 'today'
  const selected = period === 'recent' ? query.data?.recent : query.data
  const window = selected?.window
  const [selectedState, setState] = useState<ErrorRecoveryState | null>(null)
  // During a rolling release an older API has no recovery evidence: keep its records unknown.
  const recovery = selected?.recovery ?? {
    unresolved: { total: 0, entries: [] },
    unknown: { total: selected?.total ?? 0, entries: selected?.entries ?? [] },
    recovered: { total: 0, entries: [] },
  }
  const state =
    selectedState ??
    (recovery.unresolved.total ? 'unresolved' : recovery.unknown.total ? 'unknown' : 'unresolved')
  const entries = recovery[state].entries
  const tone =
    state === 'recovered'
      ? 'text-success'
      : state === 'unresolved'
        ? 'text-danger'
        : 'text-muted-foreground'

  return (
    <Card className="min-w-0">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0 p-4">
        <CardTitle className="text-sm">错误与恢复</CardTitle>
        <Link
          to="/logs"
          search={{ ...window, level: 'error' }}
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
            <div className="grid grid-cols-2 gap-2" aria-label="错误统计范围">
              <Button
                variant={period === 'today' ? 'secondary' : 'outline'}
                className="h-auto flex-col items-start gap-1 px-3 py-2"
                aria-pressed={period === 'today'}
                onClick={() => setPeriod('today')}
              >
                <span className="text-xs text-muted-foreground">今日累计</span>
                <span className="text-lg font-semibold tabular-nums">{query.data.total} 条</span>
              </Button>
              <Button
                variant={period === 'recent' ? 'secondary' : 'outline'}
                className="h-auto flex-col items-start gap-1 px-3 py-2"
                aria-pressed={period === 'recent'}
                disabled={!query.data.recent}
                onClick={() => setPeriod('recent')}
              >
                <span className="text-xs text-muted-foreground">最近 15 分钟新增</span>
                <span className="text-lg font-semibold tabular-nums">
                  {query.data.recent ? `${query.data.recent.total} 条` : '暂不可用'}
                </span>
              </Button>
            </div>
            <div className="grid grid-cols-3 gap-2" aria-label="错误恢复状态">
              {recoveryStates.map(({ key, label }) => (
                <Button
                  key={key}
                  variant={state === key ? 'secondary' : 'outline'}
                  className="h-auto flex-col gap-1 px-2 py-2"
                  aria-pressed={state === key}
                  onClick={() => setState(key)}
                >
                  <span className="text-xs">{label}</span>
                  <span
                    className={`text-lg font-semibold tabular-nums ${key === 'recovered' ? 'text-success' : key === 'unresolved' && recovery[key].total ? 'text-danger' : 'text-muted-foreground'}`}
                  >
                    {recovery[key].total} 条
                  </span>
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              已恢复有后续成功记录；待确认缺少恢复证据。数量按错误记录统计，原始日志保留。
            </p>
            {entries.length ? (
              <div
                role="log"
                aria-label={period === 'recent' ? '最近 15 分钟错误终端' : '今日错误终端'}
                className="max-h-96 overflow-auto rounded-md bg-muted/30 p-3 font-mono text-xs"
              >
                {entries.map((entry) => (
                  <div className="mb-4 last:mb-0" key={`${entry.source}:${entry.id}`}>
                    <div className="flex items-baseline gap-2 text-muted-foreground">
                      <time dateTime={new Date(entry.at).toISOString()}>
                        {new Date(entry.at).toLocaleTimeString('zh-CN', {
                          timeZone: 'Asia/Shanghai',
                          month: '2-digit',
                          day: '2-digit',
                          hour12: false,
                        })}
                      </time>
                      <span className={tone}>{entry.service}</span>
                      <span className={tone}>
                        {recoveryStates.find((item) => item.key === state)?.label}
                      </span>
                    </div>
                    <p className={`mt-1 ${tone}`}>
                      {entry.recovery?.reason ?? '暂无可关联的恢复证据'}
                      {entry.recovery?.recoveredAt != null
                        ? ` · 恢复于 ${new Date(entry.recovery.recoveredAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`
                        : ''}
                    </p>
                    {entry.route || entry.status ? (
                      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        {entry.status ? (
                          <span className={`font-semibold ${tone}`}>HTTP {entry.status}</span>
                        ) : null}
                        {entry.route ? (
                          <code className="min-w-0 break-all">{entry.route}</code>
                        ) : null}
                      </div>
                    ) : null}
                    {entry.errorCode || entry.reason ? (
                      <div className="my-1 space-y-1 break-words">
                        <p>{errorReason(entry.reason, entry.errorCode)}</p>
                        {entry.errorCode ? (
                          <p className="text-muted-foreground">错误码：{entry.errorCode}</p>
                        ) : null}
                      </div>
                    ) : entry.message === 'API request failed' ? (
                      <p className="my-1 text-muted-foreground">
                        未记录具体错误原因，可查看相关日志。
                      </p>
                    ) : null}
                    {entry.message !== 'task failed' || !entry.reason || entry.stack ? (
                      <pre className="whitespace-pre-wrap break-words leading-5">
                        {entry.message}
                        {entry.stack && !entry.message.includes(entry.stack)
                          ? `\n${entry.stack}`
                          : ''}
                      </pre>
                    ) : null}
                    <div className="mt-1 text-xs">
                      <div className="flex flex-wrap gap-2">
                        {entry.recovery?.recoveredAt != null &&
                        entry.service === 'cloudflared' &&
                        entry.instance ? (
                          <Button size="sm" variant="outline" asChild>
                            <Link
                              to="/logs"
                              search={{
                                from: entry.at - 1000,
                                to: entry.recovery.recoveredAt + 1000,
                                instance: entry.instance,
                              }}
                            >
                              恢复记录 →
                            </Link>
                          </Button>
                        ) : null}
                        {entry.task_id ? (
                          <Button size="sm" variant="outline" asChild>
                            <Link to="/tasks" search={{ ...window, task: entry.task_id }}>
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
                                    ? window!.from
                                    : Math.max(window!.from, entry.at - 60_000),
                                to:
                                  entry.request_id || !entry.instance
                                    ? window!.to
                                    : Math.min(window!.to, entry.at + 60_000),
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
                {!selected?.total
                  ? period === 'recent'
                    ? '最近 15 分钟没有新增错误日志'
                    : '今天没有采集到错误日志'
                  : state === 'unresolved'
                    ? '当前范围没有确认未恢复的错误'
                    : state === 'recovered'
                      ? '当前范围没有已确认恢复的错误'
                      : '当前范围没有待确认的错误'}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {period === 'recent' ? '最近 15 分钟' : '今日（北京时间）'} · 服务端 ERROR / FATAL
              与浏览器异常 · 每类最新 10 条 · 每 30 秒刷新
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
            search={{ ...window, level: 'fatal' }}
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

const reasons = new Map(
  Object.entries({
    confirmation_capacity_full: '同时确认的图片过多，已达到容量上限',
    processing_queue_full: '图片处理队列已满',
    processing_queue_timeout: '等待图片处理超时',
    object_lock_timeout: '等待同一图片的其他处理请求超时',
    media_processing_busy: '图片处理繁忙，暂时无法完成确认',
    media_storage_unavailable: '图片存储暂时不可用',
    media_hash_mismatch: '上传文件校验不一致',
    media_size_mismatch: '上传文件大小与声明不一致',
  }),
)

function errorReason(reason?: string | null, code?: string | null) {
  if (reason === 'No eligible Grok media accounts') return 'Grok 模型渠道暂不可用，请稍后再试'
  const key = reason ?? code
  const translation = key ? reasons.get(key) : undefined
  if (reason) return translation ? `${translation}（${reason}）` : reason
  return translation ?? '未记录具体错误原因，可查看相关日志。'
}

const recoveryStates = [
  { key: 'unresolved', label: '未恢复' },
  { key: 'unknown', label: '待确认' },
  { key: 'recovered', label: '已恢复' },
] as const
