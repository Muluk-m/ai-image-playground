import { Link, type LinkProps } from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { Fragment, type ReactNode } from 'react'

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'

export interface Crumb {
  label: string
  to?: LinkProps['to']
}

interface PageProps {
  crumbs: Crumb[]
  /** 默认取末级面包屑，只有标题需要跟面包屑不同时才传。 */
  title?: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}

export function Page({ crumbs, title, description, actions, children }: PageProps) {
  const heading = title ?? crumbs[crumbs.length - 1]?.label ?? ''
  return (
    <>
      <header className="sticky top-0 z-30 border-b bg-background/85 px-4 py-3 backdrop-blur md:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <SidebarTrigger className="-ml-1 shrink-0" />
          <Separator orientation="vertical" className="mr-1 h-4 shrink-0" />
          <Breadcrumb className="min-w-0 flex-1 overflow-hidden">
            <BreadcrumbList className="flex-nowrap overflow-hidden">
              {crumbs.map((crumb, index) => (
                <Fragment key={crumb.label}>
                  {index > 0 ? <BreadcrumbSeparator /> : null}
                  <BreadcrumbItem className="min-w-0 max-w-[min(240px,65vw)] shrink truncate">
                    {crumb.to ? (
                      <BreadcrumbLink asChild>
                        <Link to={crumb.to}>{crumb.label}</Link>
                      </BreadcrumbLink>
                    ) : (
                      <BreadcrumbPage className="truncate">{crumb.label}</BreadcrumbPage>
                    )}
                  </BreadcrumbItem>
                </Fragment>
              ))}
            </BreadcrumbList>
          </Breadcrumb>
        </div>

        <div className="mt-2 flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight">{heading}</h1>
            {description ? (
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground sm:truncate">
                {description}
              </p>
            ) : null}
          </div>
          {actions ? (
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
              {actions}
            </div>
          ) : null}
        </div>
      </header>

      <div className="flex-1 space-y-4 px-4 py-5 md:px-6">{children}</div>
    </>
  )
}

export function PendingState({ label, className }: { label: string; className?: string }) {
  return (
    <div
      className={cn(
        'flex h-40 items-center justify-center text-sm text-muted-foreground',
        className,
      )}
    >
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      {label}
    </div>
  )
}

export function ErrorState({ label, error }: { label: string; error: unknown }) {
  return (
    <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-6 text-sm text-destructive">
      {label}：{(error as Error).message}
    </div>
  )
}

export function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed bg-card/40 p-8 text-center text-sm text-muted-foreground sm:p-12">
      {label}
    </div>
  )
}
