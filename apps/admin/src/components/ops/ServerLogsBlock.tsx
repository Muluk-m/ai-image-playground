import {
  SERVER_LOG_LEVELS,
  type ServerLogEntry,
  type ServerLogFilters,
  type ServerLogPage,
  type ServerLogsResult,
} from '@image-playground/shared'
import { useInfiniteQuery } from '@tanstack/react-query'
import { defaultStringifySearch, Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { apiClient } from '@/lib/api-client'
import { LOG_RANGES, type ServerLogSearch, serverLogFilters } from '@/lib/server-log-search'

const RANGES = LOG_RANGES
const SELECT_STYLE = 'h-9 rounded-md border bg-background px-2 text-sm'
const time = (at: number) =>
  new Date(at).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
const dateInput = (at: number) => new Date(at + 8 * 3600_000).toISOString().slice(0, -1)

function LogDetails({
  entry,
  onFilter,
  onInspect,
}: {
  entry: ServerLogEntry
  onFilter: (values: Partial<ServerLogFilters>) => void
  onInspect: () => void
}) {
  return (
    <details
      className="border-t py-2 text-xs"
      onToggle={(event) => {
        if (event.currentTarget.open) onInspect()
      }}
    >
      <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1">
        <time
          className="shrink-0 text-muted-foreground"
          dateTime={new Date(entry.at).toISOString()}
        >
          {time(entry.at)}
        </time>
        <span
          className={
            entry.level === 'error' || entry.level === 'fatal'
              ? 'font-semibold text-danger'
              : entry.level === 'warn'
                ? 'font-semibold text-amber-600'
                : 'text-muted-foreground'
          }
        >
          {entry.level.toUpperCase()}
        </span>
        <span className="font-mono">{entry.service}</span>
        <span className="min-w-0 break-all font-mono">{entry.event ?? '日志'}</span>
        <span className="min-w-0 flex-1 truncate font-mono" title={entry.message}>
          {entry.message}
        </span>
      </summary>
      <div className="mt-3 space-y-2 rounded-md bg-muted/50 p-3">
        <p className="whitespace-pre-wrap break-all">{entry.message}</p>
        <p className="break-all text-muted-foreground">
          实例 {entry.instance} · 版本 {entry.version} · 日志 ID {entry.id}
        </p>
        <div className="flex flex-wrap gap-2">
          {(['userId', 'mediaId'] as const).map((key) =>
            typeof entry.fields[key] === 'string' ? (
              <Button
                key={key}
                size="sm"
                variant="outline"
                className="max-w-full whitespace-normal break-all text-left"
                onClick={() => onFilter({ [key]: String(entry.fields[key]) })}
              >
                {key === 'userId' ? '同用户' : '同图片'} {String(entry.fields[key])}
              </Button>
            ) : null,
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => onFilter({ instance: entry.instance })}
          >
            同实例
          </Button>
          <Button size="sm" variant="outline" onClick={() => onFilter({ version: entry.version })}>
            同版本
          </Button>
          {entry.request_id ? (
            <Button
              size="sm"
              variant="outline"
              className="max-w-full whitespace-normal break-all text-left"
              onClick={() => onFilter({ requestId: entry.request_id!, group: undefined })}
            >
              同请求 {entry.request_id}
            </Button>
          ) : null}
          {entry.task_id ? (
            <>
              <Button
                size="sm"
                variant="outline"
                className="max-w-full whitespace-normal break-all text-left"
                onClick={() => onFilter({ taskId: entry.task_id!, group: undefined })}
              >
                同任务 {entry.task_id}
              </Button>
              <Link
                to="/tasks/$taskId"
                params={{ taskId: entry.task_id }}
                className="self-center underline"
              >
                查看任务
              </Link>
            </>
          ) : null}
        </div>
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono">
          {JSON.stringify(entry.fields, null, 2)}
        </pre>
      </div>
    </details>
  )
}

export function ServerLogsBlock({
  searchState,
  onSearchChange,
}: {
  searchState?: ServerLogSearch
  onSearchChange?: (next: ServerLogSearch) => void
} = {}) {
  const [localState, setLocalState] = useState<ServerLogSearch>({})
  const state = searchState ?? localState
  const change = (next: ServerLogSearch) =>
    onSearchChange ? onSearchChange(next) : setLocalState(next)
  const range = state.range ?? '24h'
  const custom =
    state.from !== undefined && state.to !== undefined ? { from: state.from, to: state.to } : null
  const fixed = Boolean(custom)
  const filters = serverLogFilters(state)
  const setFilters = (values: Partial<ServerLogFilters>) =>
    change({ range: state.range, from: state.from, to: state.to, ...values })
  const setCustom = (value: { from: number; to: number } | null) =>
    change({ ...state, from: value?.from, to: value?.to })
  const [end, setEnd] = useState(() => Date.now())
  // A fixed range suspends refresh; live remembers only the user's manual pause choice.
  const [live, setLive] = useState(true)
  const previouslyFixed = useRef(fixed)
  useEffect(() => {
    if (previouslyFixed.current && !fixed) setEnd(Date.now())
    previouslyFixed.current = fixed
  }, [fixed])
  const [search, setSearch] = useState(state.q ?? '')
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle')
  useEffect(() => setSearch(state.q ?? ''), [state.q])
  const [dateError, setDateError] = useState('')
  useEffect(() => {
    if (!live || (state.from !== undefined && state.to !== undefined)) return
    const timer = setInterval(() => setEnd(Date.now()), 10_000)
    return () => clearInterval(timer)
  }, [live, state.from, state.to])
  const window = custom ?? { from: end - RANGES[range], to: end }
  const signature = JSON.stringify([filters, custom ?? range])
  const query = useInfiniteQuery({
    queryKey: ['ops-logs', window, filters, custom ? 'fixed' : range],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ from: String(window.from), to: String(window.to) })
      for (const [key, value] of Object.entries(filters)) if (value) params.set(key, String(value))
      if (pageParam) params.set('cursor', pageParam)
      return apiClient.get<ServerLogPage | ServerLogsResult>(`/api/ops/logs?${params}`)
    },
    initialPageParam: '',
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 0,
    placeholderData: (previous, previousQuery) => {
      const key = previousQuery?.queryKey
      return !custom && key?.[3] === range && JSON.stringify(key[2]) === JSON.stringify(filters)
        ? previous
        : undefined
    },
  })
  const lastGood = useRef<{ signature: string; data: NonNullable<typeof query.data> } | null>(null)
  useEffect(() => {
    if (query.data && !query.isPlaceholderData) lastGood.current = { signature, data: query.data }
  }, [query.data, query.isPlaceholderData, signature])
  const retained =
    query.data ?? (lastGood.current?.signature === signature ? lastGood.current.data : undefined)
  const firstPage = retained?.pages[0]
  const data = firstPage && 'summary' in firstPage ? firstPage : undefined
  const entries = retained?.pages.flatMap((page) => page.entries) ?? []
  const update = (values: Partial<ServerLogFilters>) => change({ ...state, ...values })
  const max = Math.max(1, ...(data?.trend.map((point) => point.count) ?? []))
  const exportLogs = () => {
    const blob = new Blob([entries.map((entry) => JSON.stringify(entry)).join('\n')], {
      type: 'application/x-ndjson',
    })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'server-logs.ndjson'
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <Card role="region" aria-label="服务端日志">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <CardTitle className="text-sm">服务端日志</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            BFF / worker · 保留近 7 天，最多约 20 万条 · 新日志约 2 秒入库
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              const url = new URL('/logs', globalThis.location.href)
              url.search = defaultStringifySearch({
                ...filters,
                from: window.from,
                to: window.to,
              })
              try {
                await navigator.clipboard.writeText(url.href)
                setCopyStatus('copied')
              } catch {
                setCopyStatus('error')
              }
            }}
          >
            {copyStatus === 'copied' ? '已复制查询链接' : '复制查询链接'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (live && !custom) setLive(false)
              else {
                setLive(true)
                setCustom(null)
                setEnd(Date.now())
              }
            }}
          >
            {live && !custom ? '暂停自动刷新' : '开启自动刷新'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={query.isFetching}
            onClick={() => {
              if (custom) void query.refetch()
              else setEnd(Date.now())
            }}
          >
            刷新
          </Button>
          <Button size="sm" variant="outline" disabled={!entries.length} onClick={exportLogs}>
            导出已加载 {entries.length} 条
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-0">
        {copyStatus === 'error' ? (
          <p role="alert" className="text-xs text-danger">
            复制失败，请允许剪贴板访问后重试。
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <select
            aria-label="日志时间范围"
            className={SELECT_STYLE}
            value={custom ? 'custom' : range}
            onChange={(event) => {
              change({
                ...state,
                range: event.target.value as keyof typeof RANGES,
                from: undefined,
                to: undefined,
              })
              setLive(true)
              setEnd(Date.now())
              setDateError('')
            }}
          >
            {custom ? <option value="custom">自定义范围</option> : null}
            <option value="15m">近 15 分钟</option>
            <option value="1h">近 1 小时</option>
            <option value="24h">近 24 小时</option>
            <option value="7d">近 7 天</option>
          </select>
          <select
            aria-label="日志服务"
            className={SELECT_STYLE}
            value={filters.service ?? ''}
            onChange={(event) =>
              update({ service: (event.target.value || undefined) as ServerLogFilters['service'] })
            }
          >
            <option value="">全部服务</option>
            <option value="bff">BFF</option>
            <option value="worker">worker</option>
          </select>
          <select
            aria-label="日志级别"
            className={SELECT_STYLE}
            value={filters.level ?? ''}
            onChange={(event) =>
              update({ level: (event.target.value || undefined) as ServerLogFilters['level'] })
            }
          >
            <option value="">全部级别</option>
            {SERVER_LOG_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level.toUpperCase()}
              </option>
            ))}
          </select>
          <form
            className="flex min-w-48 flex-1 gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              update({ q: search || undefined })
            }}
          >
            <Input
              aria-label="日志关键词"
              placeholder="搜索消息、事件、请求或任务 ID"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              maxLength={400}
            />
            <Button size="sm" variant="outline" type="submit">
              搜索
            </Button>
          </form>
        </div>
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            精确定位 / 自定义时间范围
          </summary>
          <form
            className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
            onSubmit={(event) => {
              event.preventDefault()
              const form = new FormData(event.currentTarget)
              const fromText = String(form.get('from') || '')
              const toText = String(form.get('to') || '')
              const from = fromText ? new Date(`${fromText}+08:00`).getTime() : window.from
              const to = toText ? new Date(`${toText}+08:00`).getTime() : window.to
              if (
                !Number.isFinite(from) ||
                !Number.isFinite(to) ||
                to <= from ||
                to - from > RANGES['7d'] ||
                to > Date.now() + 60_000
              ) {
                setDateError('请填写有效时间，跨度不超过 7 天，结束时间不能晚于当前时间')
                return
              }
              setDateError('')
              const located = Object.fromEntries(
                ['requestId', 'taskId', 'userId', 'mediaId', 'instance', 'version'].map((key) => [
                  key,
                  String(form.get(key) || '') || undefined,
                ]),
              )
              change({ ...state, ...located, ...(fromText || toText ? { from, to } : {}) })
            }}
          >
            <label>
              开始时间（北京时间）
              <Input
                name="from"
                type="datetime-local"
                step="0.001"
                key={`from:${custom?.from ?? range}`}
                defaultValue={custom ? dateInput(custom.from) : ''}
              />
            </label>
            <label>
              结束时间（北京时间）
              <Input
                name="to"
                type="datetime-local"
                step="0.001"
                key={`to:${custom?.to ?? range}`}
                defaultValue={custom ? dateInput(custom.to) : ''}
              />
            </label>
            <label>
              请求 ID
              <Input
                name="requestId"
                defaultValue={filters.requestId}
                key={`request:${filters.requestId}`}
                maxLength={200}
              />
            </label>
            <label>
              任务 ID
              <Input
                name="taskId"
                defaultValue={filters.taskId}
                key={`task:${filters.taskId}`}
                maxLength={200}
              />
            </label>
            {(['userId', 'mediaId', 'instance', 'version'] as const).map((key) => (
              <label key={key}>
                {{ userId: '用户 ID', mediaId: '图片 ID', instance: '实例', version: '版本' }[key]}
                <Input name={key} defaultValue={filters[key]} key={filters[key]} maxLength={400} />
              </label>
            ))}
            <Button className="self-end" size="sm" variant="outline" type="submit">
              应用范围与定位
            </Button>
          </form>
          {dateError ? (
            <p role="alert" className="mt-2 text-danger">
              {dateError}
            </p>
          ) : null}
        </details>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>
            {time(window.from)} — {time(window.to)} · 北京时间
          </span>
          <span>{live && !custom ? '每 10 秒刷新' : '已暂停自动刷新'}</span>
          {filters.group ? <span>事件：{filters.group}</span> : null}
          {filters.requestId ? <span>请求：{filters.requestId}</span> : null}
          {filters.taskId ? <span>任务：{filters.taskId}</span> : null}
          {(['userId', 'mediaId', 'instance', 'version'] as const).map((key) =>
            filters[key] ? (
              <span key={key} className="break-all">
                {key}：{filters[key]}
              </span>
            ) : null,
          )}
          {Object.values(filters).some(Boolean) ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setFilters({})
                setSearch('')
              }}
            >
              清空筛选
            </Button>
          ) : null}
        </div>
        {query.isError ? (
          <p role="alert" className="text-sm text-danger">
            {data
              ? '日志刷新失败，下面保留上次成功读取的记录，请点击刷新重试。'
              : '日志加载失败，请点击刷新重试。'}
          </p>
        ) : null}
        {data && query.isFetching ? (
          <p role="status" className="text-xs text-muted-foreground">
            正在刷新日志，下面保留上一次读取的记录。
          </p>
        ) : null}
        {!data && query.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            正在读取日志…
          </p>
        ) : null}
        {data ? (
          <>
            {data.coverage ? (
              <div role="status" className="rounded-md border bg-muted/30 p-3 text-xs">
                {data.coverage.first_at === null
                  ? '日志库尚无记录'
                  : `当前留存记录：${time(data.coverage.first_at)} — ${time(data.coverage.last_at ?? data.coverage.first_at)}`}
                {data.coverage.first_at !== null && window.from < data.coverage.first_at ? (
                  <p className="mt-1 text-amber-600">
                    查询包含留存起点之前的时段；此前记录可能尚未采集或已清理，无法据此判断没有故障。
                  </p>
                ) : null}
              </div>
            ) : null}
            {data.collectors.some(
              (collector) =>
                collector.dropped > 0 ||
                collector.pending > 100 ||
                Date.now() - collector.last_seen_at > 120_000,
            ) ? (
              <p role="status" className="text-xs text-danger">
                日志采集存在积压、丢弃或心跳过期，请展开采集状态查看；当前记录可能不完整。
              </p>
            ) : null}
            {data.collectors.length ? (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">
                  采集状态（心跳每 30 秒更新）
                </summary>
                <ul className="mt-2 space-y-1">
                  {data.collectors.map((collector) => (
                    <li
                      key={`${collector.service}:${collector.instance}`}
                      className={
                        collector.dropped > 0 ||
                        collector.pending > 100 ||
                        Date.now() - collector.last_seen_at > 120_000
                          ? 'text-danger'
                          : 'text-muted-foreground'
                      }
                    >
                      {collector.service} / {collector.instance} ·{' '}
                      {Date.now() - collector.last_seen_at > 120_000 ? '心跳已过期' : '在线'} ·
                      待入库 {collector.pending} · 累计丢弃 {collector.dropped} · 写入失败{' '}
                      {collector.failures} 次 · 最近入库{' '}
                      {collector.last_written_at ? time(collector.last_written_at) : '尚未写入'}
                    </li>
                  ))}
                </ul>
              </details>
            ) : (
              <p className="text-xs text-muted-foreground">
                尚未收到日志采集心跳，请确认 BFF 和 worker 已运行新版本。
              </p>
            )}
            <p className="text-sm">
              匹配 <strong>{data.summary.total}</strong> 条 · 错误{' '}
              <strong className="text-danger">{data.summary.errors}</strong> · 警告{' '}
              <strong>{data.summary.warnings}</strong>
            </p>
            <div>
              <p className="mb-2 text-xs text-muted-foreground">
                日志量趋势 · 每格 {Math.round(data.bucket_ms / 60_000)} 分钟 · 红色为错误
              </p>
              <svg
                role="img"
                aria-label="所选范围内日志量与错误量趋势"
                viewBox={`0 0 ${data.trend.length * 10} 60`}
                className="h-16 w-full"
                preserveAspectRatio="none"
              >
                {data.trend.map((point, index) => (
                  <g key={point.at}>
                    <title>
                      {time(point.at)}：{point.count} 条，错误 {point.errors} 条
                    </title>
                    <rect
                      x={index * 10}
                      y={60 - (point.count / max) * 60}
                      width="8"
                      height={(point.count / max) * 60}
                      className="fill-muted-foreground/40"
                    />
                    <rect
                      x={index * 10}
                      y={60 - (point.errors / max) * 60}
                      width="8"
                      height={(point.errors / max) * 60}
                      className="fill-danger"
                    />
                  </g>
                ))}
              </svg>
            </div>
            {data.groups.length ? (
              <details open>
                <summary className="cursor-pointer text-xs font-medium">
                  事件聚合 · 前 30 组，点击查看日志
                </summary>
                <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {data.groups.map((group) => (
                    <button
                      key={`${group.service}:${group.level}:${group.key}`}
                      type="button"
                      className="flex items-center justify-between gap-2 rounded-md border p-2 text-left text-xs hover:bg-muted"
                      title={`首次 ${time(group.first_at)} · 最近 ${time(group.last_at)}`}
                      onClick={() =>
                        update({ service: group.service, level: group.level, group: group.key })
                      }
                    >
                      <span className="min-w-0">
                        <span className="text-muted-foreground">
                          {group.service} / {group.level}
                        </span>
                        <span className="block truncate font-mono">{group.key || '无消息'}</span>
                      </span>
                      <strong>{group.count}</strong>
                    </button>
                  ))}
                </div>
              </details>
            ) : null}
            <div
              aria-label="日志记录"
              className="max-h-[36rem] overflow-auto rounded-md border px-3"
            >
              {!entries.length ? (
                <p className="py-4 text-sm text-muted-foreground">
                  此范围内没有匹配日志。采集从新版本启动后开始；可扩大时间范围或清空筛选。
                </p>
              ) : (
                entries.map((entry) => (
                  <LogDetails
                    key={entry.id}
                    entry={entry}
                    onFilter={(values) => {
                      setFilters(values)
                      setSearch('')
                    }}
                    onInspect={() => setLive(false)}
                  />
                ))
              )}
            </div>
            {query.hasNextPage ? (
              <Button
                variant="outline"
                size="sm"
                disabled={query.isFetching}
                onClick={() => {
                  setLive(false)
                  void query.fetchNextPage()
                }}
              >
                {query.isFetchingNextPage ? '加载中…' : '加载更早日志（暂停自动刷新）'}
              </Button>
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}
