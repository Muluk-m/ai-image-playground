import { BACKGROUND_PRESETS, findBackgroundPreset } from '@image-playground/shared'
import { describe, expect, it } from 'vitest'
import {
  backgroundBriefFromPreset,
  buildBackgroundSwapPrompt,
} from '../../../../features/remix/lib/backgroundPrompt'
import type { RemixBrief, RemixProductDescription } from '../../../../features/remix/types'

const PRODUCT: RemixProductDescription = {
  name: 'W2753 独立浴缸',
  features: '蛋形单边斜背，外沿薄壁',
  mainColor: '哑光灰棕（暖调中灰偏棕）',
  forbiddenColors: ['米白', '浅灰'],
}

const BRIEF: RemixBrief = backgroundBriefFromPreset(
  findBackgroundPreset('warm-microcement') ?? BACKGROUND_PRESETS[0],
)

describe('the background preset library', () => {
  it('ships at least ten styles, each with a wall, a floor and props', () => {
    expect(BACKGROUND_PRESETS.length).toBeGreaterThanOrEqual(10)
    for (const preset of BACKGROUND_PRESETS) {
      expect(preset.wall).not.toBe('')
      expect(preset.floor).not.toBe('')
      expect(preset.props.length).toBeGreaterThan(0)
    }
  })

  it('turns one preset into an editable brief', () => {
    expect(BRIEF.background).toContain('暖灰色微水泥墙面')
    expect(BRIEF.background).toContain('微水泥地面')
    expect(BRIEF.props).toContain('亚麻浴巾')
  })
})

describe('building the background swap prompt', () => {
  it('freezes the product and only replaces what is behind it', () => {
    const prompt = buildBackgroundSwapPrompt({ product: PRODUCT, brief: BRIEF })

    expect(prompt).toContain('图1是我方产品：W2753 独立浴缸，蛋形单边斜背，外沿薄壁')
    expect(prompt).toContain('位置、大小、角度、颜色、材质、边缘厚度')
    expect(prompt).toContain('阴影接地')
    expect(prompt).toContain('只替换产品以外的背景')
  })

  it('leaves the trade wording to the features the user typed', () => {
    const prompt = buildBackgroundSwapPrompt({
      product: { name: '产品', features: '', mainColor: '', forbiddenColors: [] },
      brief: BRIEF,
    })

    expect(prompt).not.toContain('浴缸')
    expect(prompt).not.toContain('缸沿')
  })

  it('names the target colour and the colours that must not appear', () => {
    const prompt = buildBackgroundSwapPrompt({ product: PRODUCT, brief: BRIEF })

    expect(prompt).toContain('必须保持哑光灰棕（暖调中灰偏棕）')
    expect(prompt).toContain('不得变成米白 / 浅灰')
    expect(prompt).toContain('环境光再暖再暗固有色也不变')
  })

  it('carries the chosen background and its props', () => {
    const prompt = buildBackgroundSwapPrompt({ product: PRODUCT, brief: BRIEF })

    expect(prompt).toContain('暖灰色微水泥墙面')
    expect(prompt).toContain('陶土色小凳')
  })

  it('asks for a real photo rather than a rendering', () => {
    const prompt = buildBackgroundSwapPrompt({ product: PRODUCT, brief: BRIEF })

    expect(prompt).toContain('真实实拍质感')
    expect(prompt).toContain('墙面细节轻微不均匀')
    expect(prompt).toContain('自然窗光')
    expect(prompt).toContain('景深')
    expect(prompt).toContain('CG')
    expect(prompt).toContain('色调克制')
  })

  it('never asks for a differentiated composition', () => {
    const prompt = buildBackgroundSwapPrompt({ product: PRODUCT, brief: BRIEF })

    expect(prompt).not.toContain('图2')
    expect(prompt).not.toContain('机位')
  })

  it('takes a hand written background with no props', () => {
    const prompt = buildBackgroundSwapPrompt({
      product: PRODUCT,
      brief: { ...BRIEF, background: '我自己写的日式汤屋', props: [] },
    })

    expect(prompt).toContain('我自己写的日式汤屋')
    expect(prompt).not.toContain('配件：')
  })
})
