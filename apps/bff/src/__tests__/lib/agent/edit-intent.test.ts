import { expect, it } from 'bun:test'
import { singleObjectEditIntent, wholeImageEditIntent } from '../../../lib/agent/edit-intent'

it('treats a change to one object or the background as a single-region edit', () => {
  for (const text of [
    '我想把这个浴缸换一下背景不变那种',
    '把这个杯子改成米白色的亮面釉',
    '左下角那只白色运动鞋换成黑色',
    '把底部的手写字 Yours to Create 去掉',
    '背景换成海边，人物不变',
    '只改杯子，其他不动',
    'remove the lamp on the right',
  ])
    expect(singleObjectEditIntent(text)).toBe(true)
})

it('leaves overall, style and framing requests to whole-image editing', () => {
  for (const text of [
    '把整张图调成黑白的',
    '整体调成电影感的冷色调',
    '把这张图整体变成水彩画风格',
    '把这张图变成夏天',
    '帮我高清放大一下',
    '换个角度',
    '变成夜景',
    '换成冬天',
    '把她变成卡通人物',
    '只把亮度调高一点',
    '改成日落时分的暖色',
    'make it a night scene',
    '再来一张',
    '',
  ])
    expect(singleObjectEditIntent(text)).toBe(false)
})

it('flags plainly whole-image asks so a region card is not the first move', () => {
  for (const text of [
    '变成夜景',
    '把整张图调成黑白的',
    '整体调成电影感的冷色调',
    '把这张图变成夏天',
    '帮我高清放大一下',
    '改成日落时分的暖色',
    'make it a night scene',
  ])
    expect(wholeImageEditIntent(text)).toBe(true)
  for (const text of [
    '背景换成夜景，人物不变',
    '把这张图里的沙发换成深绿色丝绒',
    '把这个杯子改成米白色的亮面釉',
    '只改杯子，其他不动',
    '换个角度',
    '再来一张',
    '',
  ])
    expect(wholeImageEditIntent(text)).toBe(false)
})
