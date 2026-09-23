import type { InspirationCategory } from '@image-playground/shared'
import { createFileRoute } from '@tanstack/react-router'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { EmptyState, ErrorState, Page, PendingState } from '@/components/Page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { ConfirmDialog } from '@/features/inspirations/ConfirmDialog'
import {
  inspirationErrorMessage,
  useCreateInspirationCategory,
  useDeleteInspirationCategory,
  useInspirationCategories,
  useInspirations,
  useUpdateInspirationCategory,
} from '@/lib/inspirations'

export const Route = createFileRoute('/_authed/inspirations/categories')({
  component: CategoriesPage,
})

function CategoriesPage() {
  const categories = useInspirationCategories()
  // 条目数只为了解释「为什么删不掉」，所以整份列表拉一次就够，不另开接口。
  const items = useInspirations()

  return (
    <Page
      crumbs={[{ label: '灵感库', to: '/inspirations' }, { label: '分类' }]}
      description="主站探索页的分类与排序"
    >
      {categories.isPending ? (
        <PendingState label="加载分类" />
      ) : categories.isError ? (
        <ErrorState label="加载分类失败" error={categories.error} />
      ) : (
        <CategoryTable
          categories={categories.data}
          usage={(items.data ?? []).reduce<Record<string, number>>((counts, item) => {
            counts[item.categoryId] = (counts[item.categoryId] ?? 0) + 1
            return counts
          }, {})}
        />
      )}
    </Page>
  )
}

function CategoryTable({
  categories,
  usage,
}: {
  categories: InspirationCategory[]
  usage: Record<string, number>
}) {
  const update = useUpdateInspirationCategory()
  const create = useCreateInspirationCategory()
  const remove = useDeleteInspirationCategory()
  const [names, setNames] = useState<Record<string, string>>({})
  const [newId, setNewId] = useState('')
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<InspirationCategory | null>(null)
  const busy = update.isPending || create.isPending || remove.isPending

  async function rename(category: InspirationCategory): Promise<void> {
    const name = names[category.id]?.trim()
    if (!name || name === category.name) return
    setError(null)
    try {
      await update.mutateAsync({ ...category, name })
      setNames((current) => ({ ...current, [category.id]: name }))
    } catch (renameError) {
      setError(inspirationErrorMessage(renameError))
    }
  }

  /**
   * 换位置 = 换 sort 值。两条 sort 撞在一起时交换等于没动，
   * 所以把被移动的那条推到邻居外侧一格。
   */
  async function move(index: number, direction: -1 | 1): Promise<void> {
    const current = categories[index]
    const neighbour = categories[index + direction]
    if (!current || !neighbour) return
    setError(null)
    try {
      if (current.sort === neighbour.sort) {
        await update.mutateAsync({ ...current, sort: neighbour.sort + direction })
        return
      }
      await update.mutateAsync({ ...current, sort: neighbour.sort })
      await update.mutateAsync({ ...neighbour, sort: current.sort })
    } catch (moveError) {
      setError(inspirationErrorMessage(moveError))
    }
  }

  async function addCategory(): Promise<void> {
    setError(null)
    try {
      await create.mutateAsync({
        id: newId.trim(),
        name: newName.trim(),
        sort: (categories[categories.length - 1]?.sort ?? 0) + 1,
      })
      setNewId('')
      setNewName('')
    } catch (createError) {
      setError(inspirationErrorMessage(createError))
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!deleting) return
    setError(null)
    try {
      await remove.mutateAsync(deleting.id)
      setDeleting(null)
    } catch (deleteError) {
      setError(inspirationErrorMessage(deleteError))
      setDeleting(null)
    }
  }

  return (
    <>
      {error ? (
        <p
          role="status"
          className="rounded-lg border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {categories.length === 0 ? (
        <EmptyState label="还没有分类，先在下面建一个" />
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-24">排序</TableHead>
                <TableHead className="w-48">id</TableHead>
                <TableHead>名称</TableHead>
                <TableHead className="w-24">条目</TableHead>
                <TableHead className="w-40 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {categories.map((category, index) => (
                <TableRow key={category.id}>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {category.sort}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{category.id}</TableCell>
                  <TableCell>
                    <Input
                      value={names[category.id] ?? category.name}
                      disabled={busy}
                      className="h-8"
                      aria-label={`分类 ${category.name} 的名称`}
                      onChange={(event) =>
                        setNames((current) => ({ ...current, [category.id]: event.target.value }))
                      }
                      onBlur={() => void rename(category)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur()
                      }}
                    />
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{usage[category.id] ?? 0}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${category.name} 上移`}
                      disabled={busy || index === 0}
                      onClick={() => void move(index, -1)}
                    >
                      <ArrowUp className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`${category.name} 下移`}
                      disabled={busy || index === categories.length - 1}
                      onClick={() => void move(index, 1)}
                    >
                      <ArrowDown className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`删除 ${category.name}`}
                      className="text-destructive hover:text-destructive"
                      disabled={busy}
                      onClick={() => setDeleting(category)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <form
        className="flex flex-wrap items-end gap-2 rounded-lg border border-dashed p-3"
        onSubmit={(event) => {
          event.preventDefault()
          void addCategory()
        }}
      >
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">id（字母数字、- 和 _）</span>
          <Input
            value={newId}
            onChange={(event) => setNewId(event.target.value)}
            pattern="[A-Za-z0-9][A-Za-z0-9_\-]*"
            required
            placeholder="portrait"
            className="h-8 w-48 font-mono text-xs"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">名称</span>
          <Input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            required
            placeholder="人像"
            className="h-8 w-56"
          />
        </label>
        <Button type="submit" size="sm" disabled={busy}>
          <Plus className="mr-1 size-4" />
          新建分类
        </Button>
      </form>

      <ConfirmDialog
        open={deleting !== null}
        title={`删除分类「${deleting?.name ?? ''}」？`}
        description={
          usage[deleting?.id ?? '']
            ? '这个分类下还有条目，服务端会拒绝删除；先把条目挪走。'
            : '分类会被删除，主站清单下次发布时同步。'
        }
        confirmLabel="删除"
        destructive
        pending={busy}
        onConfirm={() => void confirmDelete()}
        onOpenChange={(next) => {
          if (!next) setDeleting(null)
        }}
      />
    </>
  )
}
