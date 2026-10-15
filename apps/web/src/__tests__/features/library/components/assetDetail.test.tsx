// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import AssetDetail from '../../../../features/library/components/AssetDetail'
import type { AssetRecord } from '../../../../features/library/types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
it('follows remote description changes only while the local draft is pristine', () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const asset: AssetRecord = {
    id: 'asset',
    name: '街角',
    kind: 'location',
    description: 'A',
    views: [],
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: 1,
  }
  const render = (description: string) =>
    act(() => root.render(<AssetDetail asset={{ ...asset, description }} onClose={vi.fn()} />))
  try {
    render('A')
    render('B')
    const input = document.querySelector<HTMLTextAreaElement>('textarea')!
    expect(input.value).toBe('B')
    expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true)
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        'local draft',
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    render('C')
    expect(input.value).toBe('local draft')
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})
