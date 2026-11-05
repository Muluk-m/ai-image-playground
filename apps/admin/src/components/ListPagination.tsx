import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export function ListPagination({
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
}: {
  page: number
  pageSize: 50 | 100
  total: number
  onPage: (page: number) => void
  onPageSize: (pageSize: 50 | 100) => void
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const current = Math.min(page, pages)
  const from = total === 0 ? 0 : (current - 1) * pageSize + 1
  const to = Math.min(total, current * pageSize)
  const numbers = pageNumbers(current, pages)
  return (
    <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
      <span>
        第 {from}–{to} 条，共 {total.toLocaleString('zh-CN')} 条
      </span>
      <span className="ml-auto flex items-center gap-2">
        <span>每页</span>
        <Select
          value={String(pageSize)}
          onValueChange={(value) => onPageSize(value === '100' ? 100 : 50)}
        >
          <SelectTrigger className="h-8 w-[72px] text-xs" aria-label="每页条数">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="50">50</SelectItem>
            <SelectItem value="100">100</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          disabled={current <= 1}
          onClick={() => onPage(current - 1)}
          aria-label="上一页"
        >
          上一页
        </Button>
        {numbers.map((item, index) =>
          item === '…' ? (
            <span key={`gap-${index}`}>…</span>
          ) : (
            <Button
              key={item}
              variant={item === current ? 'default' : 'outline'}
              size="sm"
              className="min-w-8 px-2"
              onClick={() => onPage(item)}
              aria-current={item === current ? 'page' : undefined}
            >
              {item}
            </Button>
          ),
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={current >= pages}
          onClick={() => onPage(current + 1)}
          aria-label="下一页"
        >
          下一页
        </Button>
      </span>
    </div>
  )
}

function pageNumbers(current: number, pages: number): Array<number | '…'> {
  const wanted = new Set([1, pages, current - 1, current, current + 1])
  const sorted = [...wanted].filter((page) => page >= 1 && page <= pages).sort((a, b) => a - b)
  const out: Array<number | '…'> = []
  for (const page of sorted) {
    const previous = out[out.length - 1]
    if (typeof previous === 'number' && page - previous > 1) out.push('…')
    out.push(page)
  }
  return out
}
