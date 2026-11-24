// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AvatarCropDialog } from '../../features/billing/AvatarCropDialog'
import { friendlyBillingError } from '../../features/billing/billing-store'
import PricingSheet from '../../features/pricing/PricingSheet'
import { openPricingSheet, usePricingSheetOpen } from '../../features/pricing/pricingSheetState'
import { pointer, stubPointerApis } from '../helpers/radix'

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  stubPointerApis()
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('friendlyBillingError', () => {
  it('hides internal billing_http, network, and raw runtime errors behind friendly copy', () => {
    expect(friendlyBillingError('billing_http_502')).not.toContain('billing_http_502')
    expect(friendlyBillingError('billing_account_invalid')).not.toContain('billing_account_invalid')
    expect(friendlyBillingError('Failed to fetch')).not.toContain('Failed to fetch')
    expect(friendlyBillingError("SyntaxError: Unexpected token '<'")).not.toContain('SyntaxError')
    expect(friendlyBillingError('The operation was aborted')).not.toContain('aborted')
  })
})

describe('AvatarCropDialog error visibility and saving close guard', () => {
  it('renders upload errors inside the dialog and ignores Escape while saving', async () => {
    const onClose = vi.fn()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () =>
        root.render(
          <AvatarCropDialog
            imageUrl="blob:avatar-1"
            saving={true}
            error="上传失败，请重试"
            onClose={onClose}
            onReselect={() => {}}
            onConfirm={() => {}}
            onError={() => {}}
          />,
        ),
      )

      expect(document.querySelector('[role="alert"]')?.textContent).toContain('上传失败，请重试')

      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        )
      })
      expect(onClose).not.toHaveBeenCalled()
    } finally {
      await act(async () => root.unmount())
    }
  })
})

describe('PricingSheet backdrop dismiss', () => {
  it('closes when clicking directly on the backdrop surface', async () => {
    let sheetOpen = false
    function Fixture() {
      sheetOpen = usePricingSheetOpen()
      return <PricingSheet />
    }
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => openPricingSheet())
      await act(async () => root.render(<Fixture />))
      expect(sheetOpen).toBe(true)

      const overlaySurface = document.querySelector<HTMLElement>('[data-no-drag-select]')!
      expect(overlaySurface).toBeTruthy()
      await act(async () => {
        overlaySurface.dispatchEvent(pointer('pointerdown'))
        overlaySurface.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }))
      })
      expect(sheetOpen).toBe(false)
    } finally {
      await act(async () => root.unmount())
    }
  })
})
