// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { dragTargetIsImage } from '../../lib/dragTarget'

describe('dragTargetIsImage', () => {
  it('does not throw when the drag target is a text node', () => {
    const text = document.createTextNode('caption')

    expect(() => dragTargetIsImage(text)).not.toThrow()
    expect(dragTargetIsImage(text)).toBe(false)
    expect(dragTargetIsImage(null)).toBe(false)
  })

  it('matches an image element only', () => {
    expect(dragTargetIsImage(document.createElement('img'))).toBe(true)
    expect(dragTargetIsImage(document.createElement('div'))).toBe(false)
  })
})
