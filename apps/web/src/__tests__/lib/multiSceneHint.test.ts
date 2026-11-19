import { describe, expect, it } from 'vitest'
import { detectRequestedSceneCount, shouldShowMultiSceneHint } from '../../lib/multiSceneHint'

describe('detectRequestedSceneCount', () => {
  it.each([
    ['给我 6 个不同场景的产品图', 6],
    ['6 个不同场景', 6],
    ['给我6个不同场景', 6],
    ['六张不同的', 6],
    ['六张不同的海报', 6],
    ['10 种不同风格', 10],
    ['十个不同角度', 10],
    ['给我十张不同的', 10],
    ['两张不同的', 2],
    ['二幅不同的画', 2],
    ['给我3套不同场景的包装', 3],
    ['出 4 个不同构图', 4],
    ['5 张不同画面', 5],
    ['6 different scenes', 6],
    ['6 different scenes of a product', 6],
    ['please make 4 different images', 4],
    ['I want 8 different styles', 8],
    ['7 different angles', 7],
    ['9 different photos', 9],
    ['5 different pictures', 5],
    ['three different scenes', 3],
    ['ten different images', 10],
  ])('reads %s as %s', (prompt, count) => {
    expect(detectRequestedSceneCount(prompt)).toBe(count)
  })

  it.each([
    '一只猫',
    '给我一张图',
    '1 个不同场景',
    '11 个不同场景',
    '十一张不同的',
    '十六张不同的',
    '六十张不同的',
    '十几张不同的',
    '给我很多不同场景',
    '不同场景',
    'a beautiful scene',
    '1 different scene',
    '12 different scenes',
    '20 different scenes',
    'eleven different scenes',
    '画两个不同年龄的人站在一起',
    '三个不同颜色的球',
    '给我3套不同的包装',
    '',
    '   ',
  ])('ignores %s', (prompt) => {
    expect(detectRequestedSceneCount(prompt)).toBeNull()
  })

  it.each([
    '6 个不同场景的拼图',
    '做成宫格，6 个不同场景',
    '九宫格里放 6 个不同场景',
    '分镜：6 个不同场景',
    '拼接 6 张不同的',
    '一张图里放 6 个不同场景',
    '合成一张 6 个不同场景',
    '6 different scenes collage',
    '6 different scenes in a grid',
    'a grid of 6 different images',
    'storyboard with 6 different scenes',
  ])('excludes grid/collage prompt %s', (prompt) => {
    expect(detectRequestedSceneCount(prompt)).toBeNull()
  })
})

describe('shouldShowMultiSceneHint', () => {
  const matching = '给我 6 个不同场景的产品图'

  it('returns the requested count when n is 1 in image mode', () => {
    expect(
      shouldShowMultiSceneHint({ prompt: matching, imageCount: 1, creationMode: 'image' }),
    ).toBe(6)
  })

  it.each([2, 6, 10])('does not show when n is %s', (imageCount) => {
    expect(
      shouldShowMultiSceneHint({ prompt: matching, imageCount, creationMode: 'image' }),
    ).toBeNull()
  })

  it('does not show in agent or video mode', () => {
    expect(
      shouldShowMultiSceneHint({ prompt: matching, imageCount: 1, creationMode: 'agent' }),
    ).toBeNull()
    expect(
      shouldShowMultiSceneHint({ prompt: matching, imageCount: 1, creationMode: 'video' }),
    ).toBeNull()
  })

  it('does not show after that prompt text was dismissed', () => {
    expect(
      shouldShowMultiSceneHint({
        prompt: matching,
        imageCount: 1,
        creationMode: 'image',
        dismissedPrompt: matching,
      }),
    ).toBeNull()
  })

  it('shows again when the prompt text changes', () => {
    expect(
      shouldShowMultiSceneHint({
        prompt: '请做 4 张不同的海报',
        imageCount: 1,
        creationMode: 'image',
        dismissedPrompt: matching,
      }),
    ).toBe(4)
  })
})
