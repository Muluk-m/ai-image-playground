import { expect, it } from 'bun:test'
import { wholeImageEditIntent } from '../../../lib/agent/edit-intent'

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
