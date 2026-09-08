import { strFromU8 } from 'fflate'
import { describe, expect, it, vi } from 'vitest'
import {
  storyboardExportJson,
  storyboardMarkdown,
  storyboardZipFiles,
} from '../../../../features/video/storyboard/lib/exportStoryboard'
import type {
  StoryboardRecord,
  StoryboardShotRecord,
} from '../../../../features/video/storyboard/types'

function shot(overrides: Partial<StoryboardShotRecord>): StoryboardShotRecord {
  return {
    no: 1,
    title: '开场',
    description: '玻璃杯放在吧台',
    camera: '缓慢推进',
    line: '',
    startSeconds: 0,
    seconds: 5,
    imagePrompt: '吧台上的空玻璃杯',
    videoPrompt: '镜头缓慢推进',
    imageTaskId: 'task-1',
    imageId: 'image-1',
    videoTaskId: null,
    ...overrides,
  }
}

const RECORD: StoryboardRecord = {
  id: 'board-1',
  createdAt: 1_000,
  updatedAt: 2_000,
  title: '夏日冰饮',
  summary: '两镜讲清一杯冰饮',
  idea: '一杯夏日冰饮',
  aspectRatio: '16:9',
  totalSeconds: 10,
  videoPrompt: '冰饮玻璃杯，吧台，晨光\n镜头1（0-5秒）：空杯静置，缓慢推进',
  style: '写实',
  referenceImageId: null,
  shotImagesRequested: true,
  videoTaskId: 'video-whole',
  shots: [
    shot({}),
    shot({
      no: 2,
      title: '注水',
      line: '就是这一口',
      startSeconds: 5,
      imageTaskId: 'task-2',
      imageId: null,
      videoTaskId: 'video-2',
    }),
  ],
}

describe('分镜导出', () => {
  it('markdown 逐镜写全脚本字段', () => {
    const markdown = storyboardMarkdown(RECORD)

    expect(markdown).toContain('# 夏日冰饮')
    expect(markdown).toContain('两镜讲清一杯冰饮')
    expect(markdown).toContain('## 镜 1 · 开场')
    expect(markdown).toContain('- 画面：玻璃杯放在吧台')
    expect(markdown).toContain('- 运镜：缓慢推进')
    expect(markdown).toContain('- 台词：（无）')
    expect(markdown).toContain('## 整条视频提示词 · 10 秒')
    expect(markdown).toContain('镜头1（0-5秒）：空杯静置，缓慢推进')
    expect(markdown).toContain('- 时间：0-5 秒')
    expect(markdown).toContain('- 时间：5-10 秒')
    expect(markdown).toContain('- 图片提示词：吧台上的空玻璃杯')
    expect(markdown).toContain('- 视频提示词：镜头缓慢推进')
    // 没出图的镜照样写进脚本。
    expect(markdown).toContain('## 镜 2 · 注水')
    expect(markdown).toContain('- 台词：就是这一口')
  })

  it('json 不带本地任务 id', () => {
    const parsed = JSON.parse(storyboardExportJson(RECORD))

    expect(parsed.title).toBe('夏日冰饮')
    expect(parsed.videoPrompt).toContain('镜头1（0-5秒）')
    expect(parsed).not.toHaveProperty('videoTaskId')
    expect(parsed.shots[0].startSeconds).toBe(0)
    expect(parsed.shots).toHaveLength(2)
    expect(parsed.shots[0]).not.toHaveProperty('imageTaskId')
    expect(parsed.shots[0]).not.toHaveProperty('imageId')
    expect(parsed.shots[0]).not.toHaveProperty('videoTaskId')
    expect(parsed.shots[0].imagePrompt).toBe('吧台上的空玻璃杯')
  })

  it('只打包出过图的镜，文件名保留原始格式', async () => {
    const loadImage = vi.fn(async () => 'data:image/jpeg;base64,/9j/4AAQ')

    const files = await storyboardZipFiles(RECORD, loadImage)

    expect(Object.keys(files).sort()).toEqual(['storyboard.json', 'storyboard.md', '镜01.jpg'])
    expect(loadImage).toHaveBeenCalledTimes(1)
    expect(loadImage).toHaveBeenCalledWith('image-1')
    expect(strFromU8(files['storyboard.md']!)).toContain('# 夏日冰饮')
    expect(files['镜01.jpg']!.byteLength).toBeGreaterThan(0)
  })

  it('图丢了就只留脚本', async () => {
    const files = await storyboardZipFiles(RECORD, async () => undefined)

    expect(Object.keys(files).sort()).toEqual(['storyboard.json', 'storyboard.md'])
  })
})
