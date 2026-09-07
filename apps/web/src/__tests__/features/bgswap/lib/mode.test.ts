import { describe, expect, it } from 'vitest'
import {
  bgSwapMode,
  maskSideFor,
  swapsProduct,
} from '../../../../features/bgswap/lib/mode'

describe('reading the two segmented controls as one mode', () => {
  it('keeps the original product whatever the target says', () => {
    expect(bgSwapMode('original', 'product-only')).toBe('background')
    expect(bgSwapMode('original', 'product-and-background')).toBe('background')
  })

  it('takes the target once the product comes from an asset', () => {
    expect(bgSwapMode('asset', 'product-only')).toBe('replace-product')
    expect(bgSwapMode('asset', 'product-and-background')).toBe('replace-and-background')
  })
})

describe('which side of the mask gets repainted', () => {
  it('repaints the background when only the background changes', () => {
    expect(maskSideFor('background')).toBe('background')
  })

  it('repaints the product when only the product changes', () => {
    expect(maskSideFor('replace-product')).toBe('product')
  })

  it('asks for no mask at all when the whole picture is redrawn', () => {
    expect(maskSideFor('replace-and-background')).toBeNull()
  })
})

describe('labelling a version that swapped the product', () => {
  it('counts both replacing modes and neither the background mode nor an old record', () => {
    expect(swapsProduct('replace-product')).toBe(true)
    expect(swapsProduct('replace-and-background')).toBe(true)
    expect(swapsProduct('background')).toBe(false)
    expect(swapsProduct(undefined)).toBe(false)
  })
})
