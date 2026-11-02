import { describe, expect, it } from 'vitest'
import { tileFit } from '../../../../features/agent/lib/tileFit'

describe('tileFit', () => {
  it('fills the width for images wider than the tile and the height for taller ones', () => {
    expect(tileFit(16 / 9, 1)).toBe('width')
    expect(tileFit(2 / 3, 1)).toBe('height')
    expect(tileFit(16 / 9, 16 / 9)).toBe('width')
  })

  it('treats an unknown tile ratio as the image ratio and an unknown image as not yet placed', () => {
    expect(tileFit(4 / 3, undefined)).toBe('width')
    expect(tileFit(undefined, 1)).toBeNull()
    expect(tileFit(0, 1)).toBeNull()
  })
})
