// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import ProjectCover from '../../../../features/canvas/components/ProjectCover'

it('shows a spinner until the image loads, and never spins forever for an empty or failed cover', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () => root.render(<ProjectCover source="data:image/png;base64,AQID" chat />))
    expect(host.querySelector('[role=status] .animate-spin')).not.toBeNull()
    await act(async () => host.querySelectorAll('img')[1]!.dispatchEvent(new Event('load')))
    expect(host.querySelector('[role=status]')).toBeNull()
    await act(async () => root.render(<ProjectCover source="data:image/png;base64,BAUG" chat />))
    expect(host.querySelector('[role=status]')).not.toBeNull()
    await act(async () => host.querySelectorAll('img')[1]!.dispatchEvent(new Event('error')))
    expect(host.querySelector('[role=status]')).toBeNull()
    await act(async () => root.render(<ProjectCover chat />))
    expect(host.querySelector('[role=status]')).toBeNull()
    await act(async () => root.render(<ProjectCover chat pending />))
    expect(host.querySelector('[role=status] .animate-spin')).not.toBeNull()
  } finally {
    await act(async () => root.unmount())
  }
})

it('ends loading when cloud preview resolution fails', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('fetch', async () => Response.json({ error: 'media_not_found' }, { status: 404 }))
  const host = document.createElement('div')
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(<ProjectCover source="aip-media:11000000-0000-4000-8000-000000000001" chat />),
    )
    await vi.waitFor(() => expect(host.querySelector('[role=status]')).toBeNull())
    expect(host.querySelector('img')).toBeNull()
  } finally {
    await act(async () => root.unmount())
    vi.unstubAllGlobals()
  }
})
