// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { confirmImageBatch } from '../../lib/confirmImageBatch'
import { useStore } from '../../store'

beforeEach(() => useStore.setState({ confirmDialog: null }))

describe('confirmImageBatch', () => {
  it('imports up to three images without interrupting', () => {
    const importImages = vi.fn()
    confirmImageBatch(3, importImages)
    expect(importImages).toHaveBeenCalledOnce()
    expect(useStore.getState().confirmDialog).toBeNull()
  })

  it('defers a larger batch until explicit confirmation', () => {
    const importImages = vi.fn()
    confirmImageBatch(4, importImages)
    const dialog = useStore.getState().confirmDialog
    expect(dialog?.message).toContain('4')
    expect(dialog?.confirmText).toContain('4')
    expect(importImages).not.toHaveBeenCalled()
    dialog?.action()
    expect(importImages).toHaveBeenCalledOnce()
  })
})
