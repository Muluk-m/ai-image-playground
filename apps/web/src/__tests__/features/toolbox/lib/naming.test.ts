import { describe, expect, it } from 'vitest'
import {
  outputFileName,
  sizeDeltaLabel,
  uniqueFileNames,
} from '../../../../features/toolbox/lib/naming'

describe('outputFileName', () => {
  it('takes the extension of the bytes actually produced', () => {
    expect(outputFileName('照片.jpeg', 'image/png')).toBe('照片.png')
    expect(outputFileName('a.b.webp', 'image/jpeg')).toBe('a.b.jpg')
  })
})

describe('uniqueFileNames', () => {
  it('numbers duplicates so a ZIP never overwrites an entry', () => {
    expect(uniqueFileNames(['cover.jpg', 'cover.jpg', 'x.png', 'cover.jpg'])).toEqual([
      'cover.jpg',
      'cover-2.jpg',
      'x.png',
      'cover-3.jpg',
    ])
  })
})

describe('sizeDeltaLabel', () => {
  it('shows shrink as minus and growth as plus', () => {
    expect(sizeDeltaLabel(1000, 680)).toBe('−32%')
    expect(sizeDeltaLabel(1000, 1060)).toBe('+6%')
  })
})
