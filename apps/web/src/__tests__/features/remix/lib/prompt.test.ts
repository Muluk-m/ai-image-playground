import { describe, expect, it } from 'vitest'
import {
  buildShotPrompt,
  isRenderableShotType,
  joinPromptSections,
  productContextDescription,
  productLockSection,
  qualitySection,
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
    const prompt = build({ type: 'selling-point', copy: { title: '防滑底', subtitle: '深长缸体' } })

    expect(prompt).toContain('图上文案用中文')
    expect(prompt).toContain('标题「防滑底」')
    expect(prompt).toContain('副标题「深长缸体」')
  })

  it('spells out the selling point layout and the safe margin', () => {
    const prompt = build({ type: 'selling-point', copy: { title: '防滑底', subtitle: '深长缸体' } })

    expect(prompt).toContain('标题排在画面上方或左上')
    expect(prompt).toContain('留出干净的文案区')
    expect(prompt).toContain('文字距画面边缘 8% 以上')
  })

  it('leaves a spec diagram without a prompt', () => {
    expect(build({ type: 'spec-diagram' })).toBe('')
  })

  it('turns the remaining text zones into icon labels', () => {
    const prompt = build({
      type: 'selling-point',
      copy: { title: '防滑底', subtitle: '深长缸体' },
      brief: { ...BRIEF, textZones: ['防滑底', '深长缸体', '保温 4 小时'] },
    })

    expect(prompt).toContain('图标标签：保温 4 小时')
  })
})

describe('filling in a selling point shot that has no copy', () => {
  const EMPTY: RemixShotCopy = { title: '', subtitle: '' }

  it('takes the title and the subtitle from the brief text zones', () => {
    const prompt = build({
      type: 'selling-point',
      copy: EMPTY,
      brief: { ...BRIEF, textZones: ['一体成型缸体', '边缘薄至 8mm'] },
    })

    expect(prompt).toContain('标题「一体成型缸体」')
    expect(prompt).toContain('副标题「边缘薄至 8mm」')
  })

  it('keeps the subtitle the user typed and picks another zone for the title', () => {
    const prompt = build({
      type: 'selling-point',
      copy: { title: '', subtitle: '边缘薄至 8mm' },
      brief: { ...BRIEF, textZones: ['边缘薄至 8mm', '一体成型缸体'] },
    })

    expect(prompt).toContain('标题「一体成型缸体」')
    expect(prompt).toContain('副标题「边缘薄至 8mm」')
  })

  it('derives both lines from the product features when the brief has no text', () => {
    const prompt = build({ type: 'selling-point', copy: EMPTY })

    expect(prompt).toContain('标题「蛋形单边斜背」')
    expect(prompt).toContain('副标题「外沿薄壁」')
  })

  it('joins the derived subtitle with the punctuation of the chosen language', () => {
    const product = { ...PRODUCT, features: 'Egg-shaped shell, thin rim, slanted back' }

    expect(build({ type: 'selling-point', copy: EMPTY, product, language: 'en' })).toContain(
      '副标题「thin rim, slanted back」',
    )
    expect(build({ type: 'selling-point', copy: EMPTY, product, language: 'zh' })).toContain(
      '副标题「thin rim，slanted back」',
    )
  })

  it('falls back to the product name when nothing else is filled in', () => {
    const product = { ...PRODUCT, features: '', mainColor: '' }
    const prompt = build({ type: 'selling-point', copy: EMPTY, product })

    expect(prompt).toContain('标题「W2753 独立浴缸」')
    expect(prompt).toContain('副标题「W2753 独立浴缸」')
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

describe('composing the sections on their own', () => {
  it('builds a prompt from the product lock and the quality line alone', () => {
    const prompt = joinPromptSections([productLockSection(PRODUCT), qualitySection()])

    expect(prompt).toContain('图1是我方产品：W2753 独立浴缸')
    expect(prompt).toContain('不得变成米白 / 浅灰 / 白色 / 橄榄绿')
    expect(prompt).toContain('商业电商产品图，8K 超写实，无文字无水印')
    expect(prompt).not.toContain('图2')
  })

  it('leaves room for on-image text in the quality line when asked', () => {
    expect(qualitySection(true)).not.toContain('无文字')
  })
})
