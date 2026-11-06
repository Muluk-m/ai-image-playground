import type { AnnouncementStatus, AnnouncementType } from '@image-playground/shared'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Eye, MoreHorizontal, Plus, Search, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { EmptyState, ErrorState, Page, PendingState } from '@/components/Page'
import { SegmentedControl } from '@/components/SegmentedControl'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  type AnnouncementSearch,
  AUDIENCE_LABEL,
  announcementErrorMessage,
  exportAnnouncement,
  formatBeijing,
  formatBeijingLong,
  formatReadRate,
  IMPORTANCE_LABEL,
  parseAnnouncementSearch,
  readAnnouncementExport,
  STATUS_LABEL,
  TYPE_LABEL,
  useAnnouncementMutations,
  useAnnouncements,
} from '@/lib/announcements'

export const Route = createFileRoute('/_authed/announcements/')({
  validateSearch: parseAnnouncementSearch,
  component: AnnouncementsPage,
})

const PAGE_SIZE = 12

function AnnouncementsPage() {
  const search = Route.useSearch()
  const navigate = useNavigate()
  const list = useAnnouncements(search)
  const { importDraft } = useAnnouncementMutations()
  const fileRef = useRef<HTMLInputElement>(null)
  const [draftQuery, setDraftQuery] = useState(search.q ?? '')
  const [importError, setImportError] = useState('')

  function setSearch(next: Partial<AnnouncementSearch>) {
    void navigate({
      to: '/announcements',
      search: { ...search, ...next, page: undefined },
      replace: true,
    })
  }

  const data = list.data
  const page = search.page ?? 1
  const items = data?.items ?? []
  const start = (page - 1) * PAGE_SIZE
  const visible = items.slice(start, start + PAGE_SIZE)
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE))

  async function onImport(file: File) {
    setImportError('')
    try {
      const parsed = JSON.parse(await file.text()) as unknown
      const document = readAnnouncementExport(parsed)
      if (!document) {
        setImportError('这份 JSON 不是公告草稿')
        return
      }
      const created = await importDraft.mutateAsync(document)
      void navigate({ to: '/announcements/$id', params: { id: created.item.id } })
    } catch (error) {
      setImportError(announcementErrorMessage(error))
    }
  }

  const counts = data?.counts
  const statusOptions = (
    [
      ['all', '全部'],
      ['draft', '草稿'],
      ['scheduled', '已排期'],
      ['published', '已发布'],
      ['archived', '已归档'],
    ] as const
  ).map(([value, label]) => ({
    value,
    label: counts ? `${label} ${value === 'all' ? counts.all : counts[value]}` : label,
  }))

  return (
    <Page
      crumbs={[{ label: '运营内容' }, { label: '版本公告' }]}
      description="向主站用户推送新功能和重要通知"
      actions={
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!data?.webOrigin}
            title={data?.webOrigin ? undefined : '未配置主站地址'}
            onClick={() => {
              if (data?.webOrigin) window.open(`${data.webOrigin}/changelog`, '_blank', 'noopener')
            }}
          >
            <Eye />
            在主站预览
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileRef.current?.click()}
          >
            <Upload />
            导入为草稿
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            className="hidden"
            aria-label="导入公告 JSON"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file) void onImport(file)
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="brand"
            onClick={() => void navigate({ to: '/announcements/$id', params: { id: 'new' } })}
          >
            <Plus />
            新建公告
          </Button>
        </>
      }
    >
      <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3">
        <SegmentedControl
          label="按状态筛选"
          options={statusOptions}
          value={search.status ?? 'all'}
          onChange={(status) =>
            setSearch({ status: status === 'all' ? undefined : (status as AnnouncementStatus) })
          }
        />
        <Select
          value={search.type ?? 'all'}
          onValueChange={(type) =>
            setSearch({ type: type === 'all' ? undefined : (type as AnnouncementType) })
          }
        >
          <SelectTrigger className="h-8 w-[140px] text-xs" aria-label="类型">
            <SelectValue placeholder="类型：全部" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">类型：全部</SelectItem>
            <SelectItem value="feature">新功能</SelectItem>
            <SelectItem value="improvement">优化</SelectItem>
            <SelectItem value="notice">公告</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={search.withinDays ? String(search.withinDays) : 'all'}
          onValueChange={(value) =>
            setSearch({
              withinDays: value === 'all' ? undefined : (Number(value) as 7 | 30 | 90),
            })
          }
        >
          <SelectTrigger className="h-8 w-[160px] text-xs" aria-label="发布时间">
            <SelectValue placeholder="发布时间" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">发布时间：全部</SelectItem>
            <SelectItem value="7">近 7 天</SelectItem>
            <SelectItem value="30">近 30 天</SelectItem>
            <SelectItem value="90">近 90 天</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={search.language ?? 'all'}
          onValueChange={(language) =>
            setSearch({ language: language === 'all' ? undefined : (language as 'zh' | 'en') })
          }
        >
          <SelectTrigger className="h-8 w-[140px] text-xs" aria-label="语言">
            <SelectValue placeholder="语言" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">语言：全部</SelectItem>
            <SelectItem value="en">中 / EN</SelectItem>
            <SelectItem value="zh">仅中文</SelectItem>
          </SelectContent>
        </Select>
        <form
          className="flex min-w-[180px] flex-1 items-center gap-2"
          role="search"
          onSubmit={(event) => {
            event.preventDefault()
            setSearch({ q: draftQuery.trim() || undefined })
          }}
        >
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={draftQuery}
              onChange={(event) => setDraftQuery(event.currentTarget.value)}
              className="h-8 pl-9"
              placeholder="搜索标题或版本号"
              aria-label="搜索标题或版本号"
            />
          </div>
        </form>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setDraftQuery('')
            void navigate({ to: '/announcements', search: {}, replace: true })
          }}
        >
          清空
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          <strong className="font-semibold text-foreground">{counts?.all ?? 0}</strong> 条公告
        </span>
        <span>·</span>
        <span>
          正在展示 <strong className="font-semibold text-foreground">{items.length}</strong> 条
        </span>
        {data?.nextScheduleAt ? (
          <>
            <span>·</span>
            <span>下一条排期：{formatBeijingLong(data.nextScheduleAt)}</span>
          </>
        ) : null}
        <span className="ml-auto hidden md:inline">已读率 = 看过的用户 / 投放用户</span>
      </div>
      {importError ? <p className="text-sm text-destructive">{importError}</p> : null}

      {list.isPending ? <PendingState label="正在加载公告" /> : null}
      {list.isError ? <ErrorState label="公告加载失败" error={list.error} /> : null}
      {data && items.length === 0 ? <EmptyState label="没有符合条件的公告" /> : null}
      {data && items.length > 0 ? (
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>标题</TableHead>
                <TableHead>类型</TableHead>
                <TableHead>重要程度</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>版本</TableHead>
                <TableHead>语言</TableHead>
                <TableHead>投放对象</TableHead>
                <TableHead>发布时间</TableHead>
                <TableHead>到期</TableHead>
                <TableHead className="text-right">已读率</TableHead>
                <TableHead>更新人</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <Link
                      to="/announcements/$id"
                      params={{ id: item.id }}
                      className="block max-w-[280px] truncate font-medium"
                    >
                      {item.titleZh}
                    </Link>
                    {item.titleEn ? (
                      <span className="block max-w-[280px] truncate text-xs text-muted-foreground">
                        {item.titleEn}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <span className="rounded-md border px-2 py-0.5 text-xs">
                      {TYPE_LABEL[item.type]}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs">
                    {item.importance === 'major' ? (
                      <span className="font-medium text-warning">{IMPORTANCE_LABEL.major}</span>
                    ) : (
                      <span className="text-muted-foreground">普通</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5 text-xs">
                      <span
                        className={`size-2 rounded-full ${
                          item.effectiveStatus === 'published'
                            ? 'bg-success'
                            : item.effectiveStatus === 'scheduled'
                              ? 'bg-warning'
                              : 'bg-muted-foreground'
                        }`}
                      />
                      {STATUS_LABEL[item.effectiveStatus]}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{item.versionTag ?? '—'}</TableCell>
                  <TableCell className="space-x-1 text-xs">
                    <span className="rounded bg-muted px-1.5 py-0.5">中</span>
                    {item.titleEn && item.bodyEn ? (
                      <span className="rounded bg-muted px-1.5 py-0.5">EN</span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-xs">{AUDIENCE_LABEL[item.audience]}</TableCell>
                  <TableCell className="font-mono text-xs tabular-nums">
                    {formatBeijing(item.publishAt)}
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                    {formatBeijing(item.expireAt, false)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">
                    {formatReadRate(item.readRate)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{item.updatedBy}</TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button type="button" variant="ghost" size="icon" aria-label="更多操作">
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <Link to="/announcements/$id" params={{ id: item.id }}>
                            编辑
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => {
                            const blob = new Blob(
                              [JSON.stringify(exportAnnouncement(item), null, 2)],
                              { type: 'application/json' },
                            )
                            const url = URL.createObjectURL(blob)
                            const anchor = document.createElement('a')
                            anchor.href = url
                            anchor.download = `${item.id}.json`
                            anchor.click()
                            URL.revokeObjectURL(url)
                          }}
                        >
                          导出 JSON
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
            <span>
              第 {start + 1}–{Math.min(start + PAGE_SIZE, items.length)} 条，共 {items.length} 条
            </span>
            <span className="ml-auto flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="上一页"
                disabled={page <= 1}
                onClick={() =>
                  void navigate({
                    to: '/announcements',
                    search: { ...search, page: page - 1 },
                  })
                }
              >
                ‹
              </Button>
              <span className="rounded-md border px-2 py-1 font-medium text-foreground">
                {page}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="下一页"
                disabled={page >= pages}
                onClick={() =>
                  void navigate({
                    to: '/announcements',
                    search: { ...search, page: page + 1 },
                  })
                }
              >
                ›
              </Button>
            </span>
          </div>
        </div>
      ) : null}
    </Page>
  )
}
