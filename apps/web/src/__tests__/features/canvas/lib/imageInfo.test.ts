import { expect, it } from 'vitest'
import { CanvasDoc, type ImageEl } from '../../../../features/canvas/lib/canvasDoc'
import { canvasImageDimensions, canvasImageName } from '../../../../features/canvas/lib/imageInfo'

it('图片缩放后名称和原始像素保持不变', () => {
  const image: ImageEl = {
    id: 'a',
    type: 'image',
    fileId: 'file',
    x: 0,
    y: 0,
    width: 200,
    height: 300,
    rotation: 0,
    naturalWidth: 1439,
    naturalHeight: 2623,
    name: '账单详情.png',
  }
  expect(canvasImageName(image)).toBe('账单详情.png')
  expect(canvasImageDimensions(image, new CanvasDoc())).toEqual({ width: 1439, height: 2623 })
  expect(canvasImageDimensions({ ...image, width: 50, height: 60 }, new CanvasDoc())).toEqual({
    width: 1439,
    height: 2623,
  })
})
