import type { CompetitorBrief } from '@image-playground/shared'
import { describe, expect, it } from 'vitest'
import {
  buildRemixPlan,
  emptyProductDescription,
  formatTextList,
  parseTextList,
  remixProductDescription,
} from '../../../../features/productShots/lib/remixPlan'
import type { RemixProductDescription } from '../../../../lib/shotTypes'

const BRIEF: CompetitorBrief = {
  shotType: 'scene',
  composition: '浴缸靠窗斜放，右侧留出毛巾架',
  camera: '略高的 3/4 侧视',
  lighting: '柔和窗光',
  background: '日式木质浴室',
  props: ['毛巾', '绿植'],
  textZones: [],
  palette: ['米白', '原木'],
  productBox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
}

const PRODUCT: RemixProductDescription = {
  name: 'W2753 独立浴缸',
  features: '蛋形单边斜背',
  mainColor: '哑光灰棕',
  forbiddenColors: ['米白'],
}

function plan(patch: Partial<CompetitorBrief> = {}, level: 'low' | 'high' = 'high') {
  return buildRemixPlan({ brief: { ...BRIEF, ...patch }, product: PRODUCT, level })
}

describe('building a creative remix plan from a competitor brief', () => {
  it('locks the product with its own colour words', () => {
    expect(plan().prompt).toContain('图1是我方产品：W2753 独立浴缸，蛋形单边斜背')
    expect(plan().prompt).toContain('必须保持哑光灰棕，不得变成米白')
  })

  it('keeps the framing at the "like it" level', () => {
    const { prompt } = plan({}, 'low')

    expect(prompt).toContain('图2只作为构图、机位与布光参考')
    expect(prompt).not.toContain('背景改为与')
  })

  it('pushes the picture away from the competitor at the "unlike it" level', () => {
    const { prompt } = plan({}, 'high')

    expect(prompt).toContain('图2只作为风格与档次参考')
    expect(prompt).toContain('背景改为与「日式木质浴室」不同的另一处场景')
  })

  it('writes the on-image copy of a selling point shot instead of leaving it to the model', () => {
    const { prompt } = plan({ shotType: 'selling-point', textZones: [] })

    expect(prompt).toContain('标题「蛋形单边斜背」')
    expect(prompt).toContain('所有文字距画面边缘 8% 以上')
  })

  it('drops the colour sentence when nobody filled the main colour in', () => {
    const { prompt } = buildRemixPlan({
      brief: BRIEF,
      product: { ...PRODUCT, mainColor: '', forbiddenColors: [] },
      level: 'high',
    })

    expect(prompt).toContain('图1是我方产品：W2753 独立浴缸')
    expect(prompt).not.toContain('必须保持')
  })

  it('labels the version with the composition sentence of the brief', () => {
    expect(plan().plan).toBe('浴缸靠窗斜放，右侧留出毛巾架')
  })

  it('falls back to the shot type when the brief has no composition sentence', () => {
    expect(plan({ composition: '  ' }).plan).toBe('场景图')
  })

  it('keeps the brief fields a rerun needs and drops the shot type', () => {
    const { brief } = plan()

    expect(brief).toEqual({
      composition: BRIEF.composition,
      camera: BRIEF.camera,
      lighting: BRIEF.lighting,
      background: BRIEF.background,
      props: BRIEF.props,
      textZones: BRIEF.textZones,
      palette: BRIEF.palette,
      productBox: BRIEF.productBox,
    })
  })

  it('refuses a shot type no image model can draw', () => {
    expect(() => plan({ shotType: 'spec-diagram' })).toThrow('尺寸参数图')
  })
})

describe('describing my product for the analysis and the product lock', () => {
  const EMPTY = emptyProductDescription()

  it('keeps what the user typed', () => {
    expect(remixProductDescription(PRODUCT, '正面白底', '浴缸套图')).toEqual(PRODUCT)
  })

  it('names the product after the picked asset, then after the job', () => {
    expect(remixProductDescription(EMPTY, '正面白底', '浴缸套图').name).toBe('正面白底')
    expect(remixProductDescription(EMPTY, '  ', '浴缸套图').name).toBe('浴缸套图')
    expect(remixProductDescription(EMPTY, '', '').name).toBe('本产品')
  })
})

describe('typing a list of colours', () => {
  it('splits on the punctuation a user would type and drops the blanks', () => {
    expect(parseTextList('米白、浅灰,  白色 ，')).toEqual(['米白', '浅灰', '白色'])
  })

  it('shows the list back as one line', () => {
    expect(formatTextList(['米白', '浅灰'])).toBe('米白、浅灰')
  })
})
