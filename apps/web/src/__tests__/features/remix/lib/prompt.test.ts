import { describe, expect, it } from 'vitest'
import {
  buildShotPrompt,
  isRenderableShotType,
  productContextDescription,
} from '../../../../features/remix/lib/prompt'
import type {
  RemixBrief,
  RemixProductDescription,
  RemixShotCopy,
} from '../../../../features/remix/types'

const PRODUCT: RemixProductDescription = {
  name: 'W2753 独立浴缸',
  features: '蛋形单边斜背，外沿薄壁',
  mainColor: '哑光灰棕（暖调中灰偏棕）',
  forbiddenColors: ['米白', '浅灰', '白色', '橄榄绿'],
}

const BRIEF: RemixBrief = {
  composition: '浴缸居中偏左，占画面三分之二',
  camera: 'eye level, straight on',
  lighting: '窗口侧逆光，柔和',
  background: '奶油色微水泥墙的浴室',
  props: ['挂画', '地毯', '藤编凳'],
  textZones: [],
  palette: ['#e8e0d4', '#7a6a5a'],
  productBox: null,
}

const COPY: RemixShotCopy = { title: '', subtitle: '' }

function build(overrides: Partial<Parameters<typeof buildShotPrompt>[0]> = {}) {
  return buildShotPrompt({
    type: 'scene',
    product: PRODUCT,
    brief: BRIEF,
    copy: COPY,
    level: 'high',
    language: 'zh',
    ...overrides,
  })
}

describe('building the prompt for one shot', () => {
  it('names the target colour and the colours that must not appear', () => {
    const prompt = build()

    expect(prompt).toContain('图1是我方产品：W2753 独立浴缸，蛋形单边斜背，外沿薄壁')
    expect(prompt).toContain('必须保持哑光灰棕（暖调中灰偏棕）')
    expect(prompt).toContain('不得变成米白 / 浅灰 / 白色 / 橄榄绿')
    expect(prompt).toContain('环境光再暖再暗固有色也不变')
  })

  it('keeps the colour lock usable when no forbidden colour is listed', () => {
    const prompt = build({ product: { ...PRODUCT, forbiddenColors: [] } })

    expect(prompt).toContain('必须保持哑光灰棕（暖调中灰偏棕）')
    expect(prompt).not.toContain('不得变成')
  })

  it('drops the colour lock when no main colour is filled in', () => {
    const prompt = build({ product: { ...PRODUCT, mainColor: '', forbiddenColors: [] } })

    expect(prompt).not.toContain('必须保持')
    expect(prompt).toContain('严格保留款式')
  })

  it('forbids copying the competitor layout at the high level', () => {
    const prompt = build({ level: 'high' })

    expect(prompt).toContain('图2只作为风格与档次参考')
    expect(prompt).toContain('禁止照搬其构图、机位、道具摆位、挂画、地毯与配件')
    expect(prompt).toContain('背景改为与「奶油色微水泥墙的浴室」不同的另一处场景')
    expect(prompt).toContain('不出现挂画、地毯、藤编凳')
  })

  it('keeps the competitor layout at the low level and swaps nothing', () => {
    const prompt = build({ level: 'low' })

    expect(prompt).toContain('图2只作为构图、机位与布光参考，不要复制图2里的产品')
    expect(prompt).not.toContain('背景改为与')
  })

  it('carries the brief fields into the shot description', () => {
    const prompt = build()

    expect(prompt).toContain('画面：浴缸居中偏左，占画面三分之二')
    expect(prompt).toContain('机位：eye level, straight on')
    expect(prompt).toContain('光线：窗口侧逆光，柔和')
    expect(prompt).toContain('配色：#e8e0d4、#7a6a5a')
  })

  it('ends on the quality line with no on-image text', () => {
    expect(build()).toContain('商业电商产品图，8K 超写实，无文字无水印')
  })

  it('asks for the selling point copy in the chosen language', () => {
    const prompt = build({
      type: 'selling-point',
      copy: { title: 'Non-slip base', subtitle: 'Stays warm for hours' },
      language: 'en',
    })

    expect(prompt).toContain('图上文案用英文')
    expect(prompt).toContain('标题「Non-slip base」')
    expect(prompt).toContain('副标题「Stays warm for hours」')
    expect(prompt).toContain('拼写必须准确')
    expect(prompt).not.toContain('无文字无水印')
  })

  it('writes the selling point copy in chinese when that is the choice', () => {
    const prompt = build({ type: 'selling-point', copy: { title: '防滑底', subtitle: '' } })

    expect(prompt).toContain('图上文案用中文')
    expect(prompt).toContain('标题「防滑底」')
    expect(prompt).not.toContain('副标题')
  })

  it('leaves a spec diagram without a prompt', () => {
    expect(build({ type: 'spec-diagram' })).toBe('')
  })
})

describe('deciding which shot types get generated', () => {
  it('excludes the spec diagram only', () => {
    expect(isRenderableShotType('spec-diagram')).toBe(false)
    expect(isRenderableShotType('selling-point')).toBe(true)
    expect(isRenderableShotType('main')).toBe(true)
  })
})

describe('describing the product for the vision model', () => {
  it('joins the shape, the main colour and the forbidden colours', () => {
    expect(productContextDescription(PRODUCT)).toBe(
      '蛋形单边斜背，外沿薄壁。主色：哑光灰棕（暖调中灰偏棕）。不得出现的颜色：米白 / 浅灰 / 白色 / 橄榄绿',
    )
  })

  it('says nothing about colours that were not filled in', () => {
    expect(productContextDescription({ ...PRODUCT, mainColor: '', forbiddenColors: [] })).toBe(
      '蛋形单边斜背，外沿薄壁',
    )
  })
})
