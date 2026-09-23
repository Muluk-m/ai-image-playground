import type { InspirationAdminItem } from '@image-playground/shared'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Boxes, Search, Sparkles, User } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { NAV_GROUPS, type NavTo } from '@/components/AppSidebar'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { adminSessionQueryOptions } from '@/lib/admin-session'
import { apiClient } from '@/lib/api-client'
import { useUsers } from '@/lib/queries'
import { cn } from '@/lib/utils'

type PaletteItem =
  | { kind: 'module'; id: string; label: string; hint: string; to: NavTo }
  | { kind: 'user'; id: string; label: string; hint: string }
  | { kind: 'inspiration'; id: string; label: string; hint: string }

const KIND_ICON = { module: Boxes, user: User, inspiration: Sparkles }
const KIND_LABEL = { module: '模块', user: '用户', inspiration: '灵感' }
const INSPIRATION_STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  published: '已发布',
  archived: '已下架',
}

/** 远端两路搜索都等打字停下来再发；250ms 是「手指停顿」与「感觉即时」的折中。 */
const SEARCH_DEBOUNCE_MS = 250
const REMOTE_LIMIT = 6

/**
 * ⌘K / Ctrl+K 全局搜索。挂在 _authed 布局里一次，所有登录后的页面共用。
 * 选中对象后直接切到对应模块：用户进详情页，灵感条目回灵感库并把 id 放进 search，
 * 由灵感库路由负责打开抽屉。
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((previous) => !previous)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* Radix 关闭时卸载内容，面板里的查询词与选中项因此每次打开都是干净的。 */}
      <DialogContent
        className="top-[18%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0"
        hideCloseButton
      >
        <DialogHeader className="sr-only">
          <DialogTitle>全局搜索</DialogTitle>
        </DialogHeader>
        <PaletteBody onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  )
}

function PaletteBody({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate()
  const { data: adminSession } = useQuery(adminSessionQueryOptions)
  const [draft, setDraft] = useState('')
  const [term, setTerm] = useState('')
  const [active, setActive] = useState(0)
  const [userItems, setUserItems] = useState<PaletteItem[]>([])
  const activeRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => setTerm(draft.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draft])

  const searchable = term.length > 0
  const canSearchUsers = searchable && adminSession?.accounts_login === true

  // 灵感条目自己起一把 key，别跟灵感库页面的列表缓存串到一起——那边按状态/类型筛，这边只按词搜。
  const inspirations = useQuery({
    queryKey: ['palette', 'inspirations', term],
    queryFn: () =>
      apiClient.get<InspirationAdminItem[]>(`/api/inspirations?q=${encodeURIComponent(term)}`),
    enabled: searchable,
  })

  const modules = useMemo<PaletteItem[]>(
    () =>
      NAV_GROUPS.flatMap((group) =>
        group.entries
          .filter((entry) => !entry.gated || adminSession?.accounts_login)
          .map((entry) => ({
            kind: 'module' as const,
            id: entry.to,
            label: entry.label,
            hint: group.label,
            to: entry.to,
          })),
      ),
    [adminSession?.accounts_login],
  )

  const items = useMemo<PaletteItem[]>(() => {
    const needle = term.toLowerCase()
    const matchedModules = needle
      ? modules.filter((item) => item.label.toLowerCase().includes(needle))
      : modules
    const matchedInspirations = (inspirations.data ?? []).slice(0, REMOTE_LIMIT).map((item) => ({
      kind: 'inspiration' as const,
      id: item.id,
      label: item.title,
      hint: INSPIRATION_STATUS_LABEL[item.status] ?? item.status,
    }))
    return [...matchedModules, ...(canSearchUsers ? userItems : []), ...matchedInspirations]
  }, [canSearchUsers, inspirations.data, modules, term, userItems])

  const activeIndex = Math.min(active, Math.max(items.length - 1, 0))

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  function select(item: PaletteItem): void {
    onDone()
    if (item.kind === 'module') {
      void navigate({ to: item.to })
      return
    }
    if (item.kind === 'user') {
      void navigate({ to: '/users/$userId', params: { userId: item.id } })
      return
    }
    void navigate({ to: '/inspirations', search: { item: item.id } })
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive(Math.min(activeIndex + 1, items.length - 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(Math.max(activeIndex - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      const item = items[activeIndex]
      if (item) {
        event.preventDefault()
        select(item)
      }
    }
  }

  return (
    <>
      {canSearchUsers ? <UserMatches term={term} onMatches={setUserItems} /> : null}
      <div className="flex items-center gap-2 border-b px-4">
        <Search className="size-4 shrink-0 text-muted-foreground" />
        <Input
          autoFocus
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
          placeholder="搜索模块、用户或灵感条目…"
          aria-label="全局搜索"
          className="h-12 border-0 px-0 text-sm shadow-none focus-visible:ring-0"
        />
      </div>
      <div className="max-h-[360px] overflow-y-auto p-2">
        {items.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {searchable ? '没有匹配的对象' : '输入关键词搜索用户与灵感条目'}
          </p>
        ) : (
          items.map((item, index) => {
            const Icon = KIND_ICON[item.kind]
            const isActive = index === activeIndex
            return (
              <button
                key={`${item.kind}-${item.id}`}
                ref={isActive ? activeRef : null}
                type="button"
                onClick={() => select(item)}
                onMouseEnter={() => setActive(index)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left',
                  isActive && 'bg-muted',
                )}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{item.hint}</span>
                <span className="shrink-0 rounded border px-1.5 text-[10px] text-muted-foreground">
                  {KIND_LABEL[item.kind]}
                </span>
              </button>
            )
          })
        )}
      </div>
      <div className="flex items-center gap-3 border-t px-4 py-2 text-[10px] text-muted-foreground">
        <span>↑↓ 选择</span>
        <span>Enter 打开</span>
        <span>Esc 关闭</span>
      </div>
    </>
  )
}

/**
 * useUsers 没有 enabled 开关，条件调用 hook 又不合法，所以把它关进一个只取数不渲染的组件：
 * 没开账号体系、或者还没输入关键词时压根不挂载，面板一打开不会白拉一次全量用户列表。
 */
function UserMatches({
  term,
  onMatches,
}: {
  term: string
  onMatches: (items: PaletteItem[]) => void
}) {
  const { data } = useUsers(term)

  useEffect(() => {
    onMatches(
      (data?.users ?? []).slice(0, REMOTE_LIMIT).map((user) => ({
        kind: 'user' as const,
        id: user.id,
        label: user.username,
        hint: user.status === 'active' ? '正常' : '已停用',
      })),
    )
  }, [data, onMatches])

  return null
}
