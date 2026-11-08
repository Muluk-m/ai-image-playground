import { Link, useLocation } from '@tanstack/react-router'
import { cn } from '@/lib/utils'

const entries = [
  { to: '/inspirations', label: '条目', exact: true },
  { to: '/inspirations/categories', label: '分类', exact: true },
  { to: '/inspirations/skills', label: '技能目录', exact: true },
] as const

export function InspirationTabs() {
  const { pathname } = useLocation()
  return (
    <nav aria-label="灵感库模块" className="flex gap-1 border-b">
      {entries.map((entry) => {
        const active = pathname === entry.to
        return (
          <Link
            key={entry.to}
            to={entry.to}
            // Link's own active state is a prefix match, which would also mark 条目 current on
            // /inspirations/categories. Keep it exact like the visual state.
            activeOptions={{ exact: true }}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'border-b-2 px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground',
              active ? 'border-foreground font-medium text-foreground' : 'border-transparent',
            )}
          >
            {entry.label}
          </Link>
        )
      })}
    </nav>
  )
}
