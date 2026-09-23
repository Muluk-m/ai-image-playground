import type { InspirationKind, InspirationStatus } from '@image-playground/shared'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Plus, Search } from 'lucide-react'
import { useEffect, useState } from 'react'

import { EmptyState, ErrorState, Page, PendingState } from '@/components/Page'
import { SegmentedControl } from '@/components/SegmentedControl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { InspirationDrawer } from '@/features/inspirations/InspirationDrawer'
import { InspirationGrid } from '@/features/inspirations/InspirationGrid'
import { useInspirationCategories, useInspirations } from '@/lib/inspirations'
import { clearInspirationItem, parseInspirationsSearch } from '@/lib/search-params'

export const Route = createFileRoute('/_authed/inspirations/')({
  validateSearch: parseInspirationsSearch,
  component: InspirationsPage,
})

const STATUS_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'draft', label: '草稿' },
  { value: 'published', label: '已发布' },
  { value: 'archived', label: '已下架' },
] as const

const KIND_OPTIONS = [
  { value: 'all', label: '全部类型' },
  { value: 'showcase', label: '效果图' },
  { value: 'template', label: '模板' },
  { value: 'skill', label: '技能示例' },
] as const

/** 一屏一批：导入的存量有五百多条，整份铺出去会拉出一条几万像素的长页。 */
const PAGE_SIZE = 60

function InspirationsPage() {
  const search = Route.useSearch()
  const navigate = useNavigate()
  const [creating, setCreating] = useState(false)
  const [draftQuery, setDraftQuery] = useState(search.q ?? '')
  const [visible, setVisible] = useState(PAGE_SIZE)
  const items = useInspirations({ status: search.status, kind: search.kind, q: search.q })
  const categories = useInspirationCategories()

  // 后退 / ⌘K 改了 URL 里的 q，输入框要跟着回到 URL 说的那个词。
  useEffect(() => setDraftQuery(search.q ?? ''), [search.q])

  // 换筛选就是换一份列表，翻出来的那些不该留着。
  useEffect(() => setVisible(PAGE_SIZE), [search.status, search.kind, search.q])

  /** 筛选只改自己那一项，`item` 留着——开着抽屉调筛选不该把抽屉关掉。 */
  function setFilter(next: { status?: InspirationStatus | 'all'; kind?: InspirationKind | 'all' }) {
    void navigate({
      to: '.',
      search: (previous) => ({
        ...previous,
        ...(next.status === undefined
          ? {}
          : { status: next.status === 'all' ? undefined : next.status }),
        ...(next.kind === undefined ? {} : { kind: next.kind === 'all' ? undefined : next.kind }),
      }),
      replace: true,
    })
  }

  function closeDrawer() {
    setCreating(false)
    if (search.item) void navigate({ to: '.', search: clearInspirationItem, replace: true })
  }

  return (
    <>
      <Page
        crumbs={[{ label: '灵感库' }]}
        description="主站探索页给用户看什么"
        actions={
          <Button
            size="sm"
            disabled={!categories.data?.length}
            title={categories.data?.length ? undefined : '先在「分类」里建一个分类'}
            onClick={() => setCreating(true)}
          >
            <Plus className="mr-1 size-4" />
            新建条目
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <SegmentedControl
            label="按状态筛选"
            options={STATUS_OPTIONS}
            value={search.status ?? 'all'}
            onChange={(status) => setFilter({ status })}
          />
          <SegmentedControl
            label="按类型筛选"
            options={KIND_OPTIONS}
            value={search.kind ?? 'all'}
            onChange={(kind) => setFilter({ kind })}
          />
          <form
            className="flex min-w-0 flex-1 gap-2 sm:max-w-sm"
            role="search"
            onSubmit={(event) => {
              event.preventDefault()
              void navigate({
                to: '.',
                search: (previous) => ({ ...previous, q: draftQuery.trim() || undefined }),
                replace: true,
              })
            }}
          >
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={draftQuery}
                onChange={(event) => setDraftQuery(event.currentTarget.value)}
                className="h-8 pl-9"
                placeholder="按标题或 id 搜索"
                aria-label="搜索灵感条目"
              />
            </div>
            <Button type="submit" variant="outline" size="sm">
              查询
            </Button>
          </form>
        </div>

        {items.isPending || categories.isPending ? (
          <PendingState label="加载灵感条目" />
        ) : items.isError ? (
          <ErrorState label="加载灵感条目失败" error={items.error} />
        ) : items.data.length === 0 ? (
          <EmptyState label="这个筛选下还没有条目" />
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              共 {items.data.length} 条 · 按排序值升序，其次最近修改
              {visible < items.data.length ? ` · 已显示前 ${visible} 条` : ''}
            </p>
            <InspirationGrid
              items={items.data.slice(0, visible)}
              categories={categories.data ?? []}
              selectedId={search.item}
              onSelect={(id) =>
                void navigate({
                  to: '.',
                  search: (previous) => ({ ...previous, item: id }),
                })
              }
            />
            {visible < items.data.length ? (
              <div className="flex justify-center">
                <Button variant="outline" size="sm" onClick={() => setVisible(visible + PAGE_SIZE)}>
                  加载更多
                </Button>
              </div>
            ) : null}
          </>
        )}
      </Page>

      <InspirationDrawer
        itemId={search.item ?? null}
        creating={creating}
        categories={categories.data ?? []}
        onClose={closeDrawer}
        onCreated={(id) => {
          setCreating(false)
          void navigate({ to: '.', search: (previous) => ({ ...previous, item: id }) })
        }}
      />
    </>
  )
}
