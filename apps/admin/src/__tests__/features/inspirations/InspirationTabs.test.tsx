import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { InspirationTabs } from '@/features/inspirations/InspirationTabs'

function renderAt(path: string) {
  const root = createRootRoute({
    component: () => (
      <>
        <InspirationTabs />
        <Outlet />
      </>
    ),
  })
  const routes = ['/inspirations', '/inspirations/categories', '/inspirations/skills'].map(
    (route) => createRoute({ getParentRoute: () => root, path: route }),
  )
  const router = createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  render(<RouterProvider router={router as never} />)
}

it('marks only the open inspiration tab as the current page', async () => {
  renderAt('/inspirations/categories')
  expect(await screen.findByRole('link', { name: '分类' })).toHaveAttribute('aria-current', 'page')
  expect(screen.getByRole('link', { name: '条目' })).not.toHaveAttribute('aria-current')
  expect(screen.getByRole('link', { name: '技能目录' })).not.toHaveAttribute('aria-current')
})
