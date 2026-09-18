import { describe, expect, it } from 'vitest'
import { Box } from '../../../../features/canvas/lib/geometry'
import {
  defaultInputItems,
  generationInputIds,
  generationInputs,
  inputIndices,
  moveInputItem,
  setInputRole,
} from '../../../../features/canvas/lib/videoInputs'

const entry = (imageId: string, x: number) => ({
  imageId,
  box: new Box(x, 0, 10, 10),
  graphicIds: [],
})

describe('选中即参考的输入图', () => {
  it('按画布从左到右排，默认都是参考图', () => {
    const items = defaultInputItems([entry('c', 300), entry('a', 0), entry('b', 100)])
    expect(items.map((one) => [one.entry.imageId, one.role])).toEqual([
      ['a', 'reference'],
      ['b', 'reference'],
      ['c', 'reference'],
    ])
  })

  it('首帧、尾帧各只能有一张：标给别的图时原来那张退回参考', () => {
    let items = defaultInputItems([entry('a', 0), entry('b', 100), entry('c', 200)])
    items = setInputRole(items, 0, 'first')
    items = setInputRole(items, 2, 'first')
    items = setInputRole(items, 1, 'last')
    expect(items.map((one) => one.role)).toEqual(['reference', 'last', 'first'])
  })

  it('拖动改顺序', () => {
    const items = defaultInputItems([entry('a', 0), entry('b', 100), entry('c', 200)])
    expect(moveInputItem(items, 2, 0).map((one) => one.entry.imageId)).toEqual(['c', 'a', 'b'])
    expect(moveInputItem(items, 0, 2).map((one) => one.entry.imageId)).toEqual(['b', 'c', 'a'])
  })

  it('生成记录按角色记，参考图保持面板顺序', () => {
    let items = defaultInputItems([entry('a', 0), entry('b', 100), entry('c', 200)])
    items = setInputRole(moveInputItem(items, 2, 0), 1, 'first')
    expect(generationInputs(items)).toEqual({ firstFrameId: 'a', referenceIds: ['c', 'b'] })
  })

  it('提交顺序是首帧、尾帧、参考图，下标与之一一对应', () => {
    const record = { firstFrameId: 'f', lastFrameId: 'l', referenceIds: ['r1', 'r2'] }
    expect(generationInputIds(record)).toEqual(['f', 'l', 'r1', 'r2'])
    expect(inputIndices(record)).toEqual({
      first_frame_index: 0,
      last_frame_index: 1,
      reference_image_indices: [2, 3],
    })
    expect(inputIndices({ referenceIds: ['r1'] })).toEqual({ reference_image_indices: [0] })
    expect(inputIndices({ lastFrameId: 'l' })).toEqual({ last_frame_index: 0 })
    expect(inputIndices({})).toEqual({})
  })
})
