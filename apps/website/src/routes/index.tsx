import { createFileRoute } from '@tanstack/react-router'
import { findPage } from '../catalog'
import { Site } from '../components/Site'
import { pageHead } from '../head'
export const Route = createFileRoute('/')({
  head: () => pageHead(findPage('/')!),
  component: () => <Site page={findPage('/')!} />,
})
