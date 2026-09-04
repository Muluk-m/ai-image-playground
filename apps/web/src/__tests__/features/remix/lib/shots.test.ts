import { BACKGROUND_PRESETS, type BackgroundPreset } from '@image-playground/shared'
import { describe, expect, it } from 'vitest'
import { backgroundBriefFromPreset } from '../../../../features/remix/lib/backgroundPrompt'
import { expandOwnShots, type ShotContext } from '../../../../features/remix/lib/shots'
import type { RemixSetSettings } from '../../../../features/remix/types'

const SETTINGS: RemixSetSettings = {
  platform: 'amazon',
  language: 'zh',
  level: 'high',
  product: {
    name: 'W2753 独立浴缸',
    features: '蛋形单边斜背',
    mainColor: '哑光灰棕',
    forbiddenColors: ['米白'],
  },
}

const CONTEXT: ShotContext = {
  sourceKind: 'own',
  settings: SETTINGS,
  productImageFor: () => 'never-used',
}

const STYLES = BACKGROUND_PRESETS.slice(0, 2)

describe('expanding own images into shots', () => {
  it('makes one shot per image and style', () => {
    const shots = expandOwnShots(['img-a', 'img-b', 'img-c'], STYLES, CONTEXT)

    expect(shots).toHaveLength(6)
    expect(shots.map((shot) => shot.sourceImageId)).toEqual([
      'img-a',
      'img-a',
      'img-b',
      'img-b',
      'img-c',
      'img-c',
    ])
    expect(shots.map((shot) => shot.brief.background)).toEqual([
      backgroundBriefFromPreset(STYLES[0] as BackgroundPreset).background,
      backgroundBriefFromPreset(STYLES[1] as BackgroundPreset).background,
      backgroundBriefFromPreset(STYLES[0] as BackgroundPreset).background,
      backgroundBriefFromPreset(STYLES[1] as BackgroundPreset).background,
      backgroundBriefFromPreset(STYLES[0] as BackgroundPreset).background,
      backgroundBriefFromPreset(STYLES[1] as BackgroundPreset).background,
    ])
  })

  it('uses the own image as its own base image so the shot can run', () => {
    const [shot] = expandOwnShots(['img-a'], STYLES, CONTEXT)

    expect(shot?.productImageId).toBe('img-a')
    expect(shot?.referenceImageId).toBeUndefined()
    expect(shot?.enabled).toBe(true)
  })

  it('writes the background swap prompt, not the competitor one', () => {
    const [shot] = expandOwnShots(['img-a'], STYLES, CONTEXT)

    expect(shot?.prompt).toContain('只替换产品以外的背景')
    expect(shot?.prompt).toContain('真实实拍质感')
    expect(shot?.prompt).not.toContain('图2')
  })

  it('gives back nothing when no style is picked', () => {
    expect(expandOwnShots(['img-a'], [], CONTEXT)).toEqual([])
  })
})
