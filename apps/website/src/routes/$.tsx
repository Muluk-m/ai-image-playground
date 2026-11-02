import { createFileRoute, notFound } from '@tanstack/react-router'
import { findPage } from '../catalog'
import { Site } from '../components/Site'
import { pageHead } from '../head'
export const Route = createFileRoute('/$')({
  loader: ({ location }) => {
    const page = findPage(location.pathname)
    if (!page) throw notFound()
    return page
  },
  head: ({ loaderData }) => (loaderData ? pageHead(loaderData) : {}),
  component: () => <Site page={Route.useLoaderData()} />,
})
