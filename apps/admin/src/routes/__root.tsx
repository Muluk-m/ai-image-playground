import type { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router'

import { NotFound } from '@/components/NotFound'
import { TooltipProvider } from '@/components/ui/tooltip'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
})

function RootComponent() {
  return (
    <TooltipProvider delayDuration={200}>
      <div className="min-h-screen bg-background text-foreground">
        <Outlet />
      </div>
    </TooltipProvider>
  )
}

function NotFoundComponent() {
  return <NotFound />
}
