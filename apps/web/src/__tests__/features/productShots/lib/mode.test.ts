import { describe, expect, it } from 'vitest'
import {
  changesBackground,
  legacyJobMode,
  maskSideFor,
} from '../../../../features/productShots/lib/mode'

describe('reading an old record as one action', () => {
  it('keeps the original product whatever the target says', () => {
    expect(legacyJobMode('original', 'product-only')).toBe('background')
    expect(legacyJobMode('original', 'product-and-background')).toBe('background')
  })

  it('takes the target once the product comes from an asset', () => {
    expect(legacyJobMode('asset', 'product-only')).toBe('replace-product')
    expect(legacyJobMode('asset', 'product-and-background')).toBe('replace-and-background')
  })

  it('reads a record that predates both fields as a background swap', () => {
    expect(legacyJobMode(undefined, undefined)).toBe('background')
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
    expect(maskSideFor('remix')).toBeNull()
  })
})

describe('whether the background plan sentence applies to a version', () => {
  it('drops it only for the mode that leaves the background alone', () => {
    expect(changesBackground('replace-product')).toBe(false)
    expect(changesBackground('background')).toBe(true)
    expect(changesBackground('replace-and-background')).toBe(true)
    expect(changesBackground('remix')).toBe(true)
    expect(changesBackground(undefined)).toBe(true)
  })
})
