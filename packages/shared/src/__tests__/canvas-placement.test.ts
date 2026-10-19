import { expect, it } from 'bun:test'
import type { CanvasNode } from '../canvas-document'
import { nodeCardSize } from '../canvas-placement'

it('fits image cards to their natural ratio without cropping', () => {
  const node = {
    id: 'image',
    type: 'image',
    x: 0,
    y: 0,
    width: 360,
    height: 240,
    data: { naturalWidth: 1568, naturalHeight: 1404 },
  } as CanvasNode

  expect(nodeCardSize(node)).toEqual({ width: 268, height: 240 })
})

it('keeps the standard media card size when intrinsic dimensions are unavailable', () => {
  const node = {
    id: 'image',
    type: 'image',
    x: 0,
    y: 0,
    width: 360,
    height: 240,
    data: {},
  } as CanvasNode

  expect(nodeCardSize(node)).toEqual({ width: 360, height: 240 })
})
