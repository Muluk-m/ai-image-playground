import {
  SERVER_LOG_LEVELS,
  SERVER_LOG_SERVICES,
  type ServerLogEntry,
  type ServerLogFilters,
  type ServerLogPage,
  type ServerLogsResult,
} from '@image-playground/shared'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { defaultStringifySearch, Link } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { apiClient } from '@/lib/api-client'
import {
  formatLogExpression,
  LOG_RANGES,
  logTrendSelection,
  parseLogExpression,
  type ServerLogSearch,
  serverLogFilters,
} from '@/lib/server-log-search'

const RANGES = LOG_RANGES
const SELECT_STYLE = 'h-9 rounded-md border bg-background px-2 text-sm'
const time = (at: number) =>
  new Date(at).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
const dateInput = (at: number) => new Date(at + 8 * 3600_000).toISOString().slice(0, -1)

function levelStyle(level: string) {
  if (level === 'error' || level === 'fatal') return 'text-danger bg-danger/5'
  if (level === 'warn') return 'text-amber-600 bg-amber-500/5'
  return 'text-muted-foreground'
}

function LogDetailContent({
  entry,
  onFilter,
}: {
  entry: ServerLogEntry
  onFilter: (values: Partial<ServerLogFilters>) => void
}) {
  return (
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
        <Button size="sm" variant="outline" onClick={() => onFilter({ instance: entry.instance })}>
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
  const expressionFilters = useRef<Partial<ServerLogFilters> | null>(null)
  const syncedQuery = useRef(state.q)
  const filterSignature = JSON.stringify(filters)
  useEffect(() => {
    const previousQuery = syncedQuery.current
    syncedQuery.current = state.q
    const expression = expressionFilters.current
    if (
      expression &&
      expression.q === state.q &&
      Object.entries(expression).every(
        ([key, value]) => state[key as keyof ServerLogFilters] === value,
      )
    )
      return
    if (expression) {
      const remaining = Object.fromEntries(
        Object.entries(expression).filter(
          ([key, value]) => key !== 'q' && state[key as keyof ServerLogFilters] === value,
        ),
      )
      if (state.q) remaining.q = state.q
      expressionFilters.current = Object.keys(remaining).length ? remaining : null
      setSearch(formatLogExpression(remaining))
    } else if (previousQuery !== state.q) setSearch(state.q ?? '')
  }, [filterSignature, state.q])
  const [selected, setSelected] = useState<ServerLogEntry | null>(null)
  const [showContext, setShowContext] = useState(false)
  const [searchError, setSearchError] = useState('')
  const list = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null)
  const context = useQuery({
    queryKey: ['log-context', selected?.id],
    queryFn: () =>
      apiClient.get<{ entries: ServerLogEntry[] }>(`/api/ops/logs/context?id=${selected!.id}`),
    enabled: Boolean(selected && showContext),
  })
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
  useEffect(() => {
    if (live && !fixed && list.current) list.current.scrollTop = 0
  }, [query.data, live, fixed])
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
  const openLog = (entry: ServerLogEntry) => {
    setLive(false)
    setSelected(entry)
    setShowContext(false)
  }
  const pointerBucket = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return Math.max(
      0,
      Math.min(
        (data?.trend.length ?? 1) - 1,
        Math.floor(
          ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * (data?.trend.length ?? 1),
        ),
      ),
    )
  }
  return (
    <Card role="region" aria-label="服务端日志" className="overflow-hidden">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 border-b p-3">
        <span className="text-xs text-muted-foreground">
          {time(window.from)} — {time(window.to)} · 北京时间
        </span>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={live && !custom ? 'default' : 'outline'}
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
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              const url = new URL('/logs', globalThis.location.href)
              url.search = defaultStringifySearch({ ...filters, from: window.from, to: window.to })
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
          <Button size="sm" variant="outline" disabled={!entries.length} onClick={exportLogs}>
            导出已加载 {entries.length} 条
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 p-3">
        <div className="grid gap-2 lg:grid-cols-[auto_auto_auto_1fr]">
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
            {SERVER_LOG_SERVICES.map((service) => (
              <option key={service} value={service}>
                {service}
              </option>
            ))}
          </select>
          <select
            aria-label="日志输出流"
            className={SELECT_STYLE}
            value={filters.stream ?? ''}
            onChange={(event) =>
              update({ stream: (event.target.value || undefined) as ServerLogFilters['stream'] })
            }
          >
            <option value="">stdout + stderr</option>
            <option value="stdout">stdout</option>
            <option value="stderr">stderr</option>
          </select>
          <form
            className="flex min-w-0 gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              try {
                const parsed = parseLogExpression(search)
                const next = { ...state }
                for (const key of Object.keys(expressionFilters.current ?? {}))
                  delete next[key as keyof ServerLogFilters]
                expressionFilters.current = Object.values(parsed).some(
                  (value) => value !== undefined,
                )
                  ? parsed
                  : null
                change({ ...next, ...parsed })
                setSearchError('')
              } catch (error) {
                setSearchError((error as Error).message)
              }
            }}
          >
            <Input
              aria-label="日志关键词"
              placeholder="搜索日志 · service:worker level:error taskId:…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              maxLength={1200}
            />
            <Button size="sm" type="submit">
              搜索
            </Button>
          </form>
        </div>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="日志级别">
          <Button
            size="sm"
            variant={!filters.level ? 'secondary' : 'ghost'}
            aria-pressed={!filters.level}
            onClick={() => update({ level: undefined })}
          >
            全部级别
          </Button>
          {SERVER_LOG_LEVELS.map((level) => (
            <Button
              key={level}
              size="sm"
              variant={filters.level === level ? 'secondary' : 'ghost'}
              className={levelStyle(level)}
              aria-pressed={filters.level === level}
              onClick={() => update({ level: filters.level === level ? undefined : level })}
            >
              {level.toUpperCase()} {data?.levelCounts ? (data.levelCounts[level] ?? 0) : '—'}
            </Button>
          ))}
          <details className="ml-auto text-xs">
            <summary className="cursor-pointer rounded-md border px-3 py-2">更多查询条件</summary>
            <form
              className="mt-3 grid gap-3 rounded-md border p-3 sm:grid-cols-2 lg:grid-cols-4"
              onSubmit={(event) => {
                event.preventDefault()
                const form = new FormData(event.currentTarget)
                const fromText = String(form.get('from') || ''),
                  toText = String(form.get('to') || '')
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
                  [
                    'requestId',
                    'taskId',
                    'userId',
                    'mediaId',
                    'instance',
                    'version',
                    'deployment',
                  ].map((key) => [key, String(form.get(key) || '') || undefined]),
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
              {(['requestId', 'taskId', 'userId', 'mediaId', 'instance', 'version'] as const).map(
                (key) => (
                  <label key={key}>
                    {
                      {
                        requestId: '请求 ID',
                        taskId: '任务 ID',
                        userId: '用户 ID',
                        mediaId: '图片 ID',
                        instance: '容器',
                        version: '版本',
                      }[key]
                    }
                    <Input
                      name={key}
                      defaultValue={filters[key]}
                      key={filters[key] ?? ''}
                      maxLength={400}
                    />
                  </label>
                ),
              )}
              <label>
                部署
                <select
                  name="deployment"
                  className={`${SELECT_STYLE} w-full`}
                  key={filters.deployment ?? ''}
                  defaultValue={filters.deployment ?? ''}
                >
                  <option value="">全部部署</option>
                  <option value="paid">付费</option>
                  <option value="internal">内部</option>
                  <option value="test">测试</option>
                </select>
              </label>
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
        </div>
        {Object.values(filters).some(Boolean) ? (
          <div className="flex flex-wrap gap-2 text-xs">
            {Object.entries(filters)
              .filter(([, value]) => value)
              .map(([key, value]) => (
                <button
                  type="button"
                  key={key}
                  className="max-w-full truncate rounded-full border bg-muted/40 px-2 py-1 font-mono"
                  onClick={() => {
                    update({ [key]: undefined })
                    if (key === 'q') setSearch('')
                  }}
                  title={`移除 ${key}`}
                >
                  {key}:{String(value)} ×
                </button>
              ))}
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
          </div>
        ) : null}
        {searchError ? (
          <p role="alert" className="text-xs text-danger">
            {searchError}
          </p>
        ) : null}
        {copyStatus === 'error' ? (
          <p role="alert" className="text-xs text-danger">
            复制失败，请允许剪贴板访问后重试。
          </p>
        ) : null}
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
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <p>
                匹配 <strong>{data.summary.total}</strong> 条 · 错误{' '}
                <strong className="text-danger">{data.summary.errors}</strong> · 警告{' '}
                <strong className="text-amber-600">{data.summary.warnings}</strong>
              </p>
              <a href="/ops" className="ml-auto underline text-muted-foreground">
                采集容器状态
              </a>
              <span className="text-muted-foreground">
                {live && !custom ? '● 跟随最新 · 每 10 秒刷新' : '已暂停自动刷新'}
              </span>
            </div>
            <div
              className="relative touch-none rounded-md bg-muted/20"
              role="group"
              aria-label="日志趋势范围"
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId)
                const index = pointerBucket(event)
                setDrag({ start: index, end: index })
              }}
              onPointerMove={(event) => {
                if (drag) setDrag({ ...drag, end: pointerBucket(event) })
              }}
              onPointerUp={(event) => {
                if (!drag) return
                const endIndex = pointerBucket(event),
                  first = data.trend[Math.min(drag.start, endIndex)],
                  last = data.trend[Math.max(drag.start, endIndex)]
                if (first && last) {
                  const selection = logTrendSelection(
                    window.from,
                    window.to,
                    first.at,
                    last.at,
                    data.bucket_ms,
                  )
                  if (selection) {
                    setLive(false)
                    setCustom(selection)
                  }
                }
                setDrag(null)
              }}
              onPointerCancel={() => setDrag(null)}
            >
              <svg
                role="img"
                aria-label="所选范围内日志量与错误量趋势"
                viewBox={`0 0 ${data.trend.length * 10} 48`}
                className="h-12 w-full"
                preserveAspectRatio="none"
              >
                {data.trend.map((point, index) => (
                  <g key={point.at}>
                    <title>
                      {time(point.at)}：{point.count} 条，错误 {point.errors} 条，警告{' '}
                      {point.warnings ?? 0} 条
                    </title>
                    <rect
                      x={index * 10}
                      y={48 - (point.count / max) * 48}
                      width="8"
                      height={(point.count / max) * 48}
                      className="fill-muted-foreground/40"
                    />
                    <rect
                      x={index * 10}
                      y={48 - ((point.errors + (point.warnings ?? 0)) / max) * 48}
                      width="8"
                      height={((point.warnings ?? 0) / max) * 48}
                      className="fill-amber-500"
                    />
                    <rect
                      x={index * 10}
                      y={48 - (point.errors / max) * 48}
                      width="8"
                      height={(point.errors / max) * 48}
                      className="fill-danger"
                    />
                  </g>
                ))}
                {drag ? (
                  <rect
                    x={Math.min(drag.start, drag.end) * 10}
                    y="0"
                    width={(Math.abs(drag.start - drag.end) + 1) * 10}
                    height="48"
                    className="fill-primary/20"
                  />
                ) : null}
              </svg>
            </div>
            <div
              ref={list}
              aria-label="日志记录"
              className="max-h-[65vh] overflow-auto rounded-md border"
              onScroll={(event) => {
                if (live && event.currentTarget.scrollTop > 48) setLive(false)
              }}
            >
              <div className="sticky top-0 z-10 grid min-w-[720px] grid-cols-[170px_70px_110px_1fr] gap-3 border-b bg-muted px-3 py-2 text-xs font-medium">
                <span>时间</span>
                <span>级别</span>
                <span>服务</span>
                <span>消息</span>
              </div>
              {!entries.length ? (
                <p className="px-3 py-8 text-sm text-muted-foreground">
                  此范围内没有匹配日志。可扩大时间范围或清空筛选。
                </p>
              ) : (
                entries.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    aria-label={`${entry.level.toUpperCase()} ${entry.service} ${entry.message}`}
                    className={`grid w-full min-w-[720px] grid-cols-[170px_70px_110px_1fr] items-baseline gap-3 border-b px-3 py-2 text-left font-mono text-xs hover:bg-muted/60 ${levelStyle(entry.level)}`}
                    onClick={() => openLog(entry)}
                  >
                    <time
                      className="text-muted-foreground"
                      dateTime={new Date(entry.at).toISOString()}
                    >
                      {time(entry.at)}
                    </time>
                    <span className="font-semibold">{entry.level.toUpperCase()}</span>
                    <span>{entry.service}</span>
                    <span className="truncate text-foreground" title={entry.message}>
                      {entry.message || entry.event || '日志'}
                    </span>
                  </button>
                ))
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{entries.length} 条已加载 · 保留近 7 天</span>
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
            </div>
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">事件聚合与留存范围</summary>
              <div className="mt-2 flex flex-wrap gap-2">
                {data.groups.map((group) => (
                  <Button
                    key={`${group.service}:${group.level}:${group.key}`}
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      update({ service: group.service, level: group.level, group: group.key })
                    }
                  >
                    {group.service} / {group.level} · {group.key || '无消息'} · {group.count}
                  </Button>
                ))}
              </div>
              {data.coverage ? (
                <p className="mt-2">
                  {data.coverage.first_at === null
                    ? '日志库尚无记录'
                    : `当前留存记录：${time(data.coverage.first_at)} — ${time(data.coverage.last_at ?? data.coverage.first_at)}`}
                </p>
              ) : null}
              {data.coverage?.first_at != null && window.from < data.coverage.first_at ? (
                <p className="mt-1 text-amber-600">
                  查询包含留存起点之前的时段；此前记录可能尚未采集或已清理，无法据此判断没有故障。
                </p>
              ) : null}
            </details>
          </>
        ) : null}
      </CardContent>
      <Sheet
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(null)
        }}
      >
        <SheetContent className="overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>日志详情</SheetTitle>
            <SheetDescription>
              {selected
                ? `${time(selected.at)} · ${selected.level.toUpperCase()} · ${selected.service}`
                : ''}
            </SheetDescription>
          </SheetHeader>
          {selected ? (
            <>
              <LogDetailContent
                entry={selected}
                onFilter={(values) => {
                  setFilters(values)
                  setSearch('')
                  setSelected(null)
                }}
              />
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => setShowContext(!showContext)}
              >
                {showContext ? '收起上下文' : '查看同容器前后 50 行'}
              </Button>
              {showContext ? (
                <div
                  className="mt-3 space-y-1 rounded-md border p-2 font-mono text-xs"
                  aria-label="日志上下文"
                >
                  {context.isPending ? <p>正在读取上下文…</p> : null}
                  {context.isError ? (
                    <p role="alert" className="text-danger">
                      上下文读取失败{' '}
                      <button type="button" onClick={() => void context.refetch()}>
                        重试
                      </button>
                    </p>
                  ) : null}
                  {context.data?.entries.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      className={`block w-full break-all rounded p-2 text-left hover:bg-muted ${entry.id === selected.id ? 'bg-primary/10 ring-1 ring-primary' : levelStyle(entry.level)}`}
                      onClick={() => {
                        setSelected(entry)
                        setShowContext(false)
                      }}
                    >
                      {time(entry.at)} {entry.level.toUpperCase()} {entry.message}
                    </button>
                  ))}
                  {context.data && !context.data.entries.length ? (
                    <p>这条日志已不在留存范围内。</p>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </Card>
  )
}
