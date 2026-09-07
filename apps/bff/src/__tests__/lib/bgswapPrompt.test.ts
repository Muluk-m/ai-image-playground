import { describe, expect, it } from 'bun:test'
import { buildBackgroundPrompt } from '@image-playground/shared'

const PLAN_ZH = '暖白微水泥墙面，浅橡木地板，左侧柔和窗光，一株散尾葵与一条亚麻毛巾。'
const PLAN_EN = 'Warm microcement wall, pale oak floor, soft window light from the left, one palm.'
const INVENTORY_ZH = ['浴缸', '落地龙头']
const INVENTORY_EN = ['the bathtub', 'the floor-standing tap']
/** 写死品类词是本次要根除的反模式，产出里出现任何一个就算回潮。 */
const HARD_CODED_PARTS = ['龙头', '排水', '把手', '底座', 'faucet', 'drain', 'handles', 'feet']

describe('buildBackgroundPrompt', () => {
  it('runs the untouched section, the plan, the realism and the quality clause in order (zh)', () => {
    const prompt = buildBackgroundPrompt({
      plan: PLAN_ZH,
      sceneType: 'photo',
      language: 'zh',
      inventory: INVENTORY_ZH,
    })

    expect(prompt).toContain('不动的部分：浴缸、落地龙头。')
    expect(prompt).toContain(`要换的部分：${PLAN_ZH}`)
    expect(prompt).toContain('真实房屋实拍')
    expect(prompt).toContain('写实商业摄影，清晰锐利')
    expect(prompt.indexOf('不动的部分')).toBeLessThan(prompt.indexOf('要换的部分'))
    expect(prompt.indexOf(PLAN_ZH)).toBeLessThan(prompt.indexOf('真实房屋实拍'))
    expect(prompt.indexOf('真实房屋实拍')).toBeLessThan(prompt.indexOf('写实商业摄影'))
  })

  it('states the untouched attributes and forbids restyling or moving them (zh)', () => {
    const prompt = buildBackgroundPrompt({
      plan: PLAN_ZH,
      sceneType: 'photo',
      inventory: INVENTORY_ZH,
    })

    expect(prompt).toContain(
      '形状、位置、朝向、比例、颜色、材质与表面纹理（颗粒、哑光、纹路）全部不变',
    )
    expect(prompt).toContain('不得重画、不得平滑、不得改款')
    expect(prompt).toContain('不得移动或缩放')
  })

  it('forbids a prop of the same kind as anything untouched, right after the plan (zh)', () => {
    const prompt = buildBackgroundPrompt({
      plan: PLAN_ZH,
      sceneType: 'photo',
      inventory: INVENTORY_ZH,
    })

    expect(prompt).toContain('不得新增任何与不动的部分同类的物件')
    expect(prompt.indexOf(PLAN_ZH)).toBeLessThan(
      prompt.indexOf('不得新增任何与不动的部分同类的物件'),
    )
    expect(prompt.indexOf('不得新增任何与不动的部分同类的物件')).toBeLessThan(
      prompt.indexOf('墙面、半墙、台面与地面'),
    )
  })

  it('falls back to the generic untouched clause when the inventory is empty', () => {
    expect(buildBackgroundPrompt({ plan: PLAN_ZH, sceneType: 'photo' })).toContain(
      '不动的部分：产品本身及所有与之相连的部件。',
    )
    expect(
      buildBackgroundPrompt({ plan: PLAN_ZH, sceneType: 'photo', inventory: ['  ', ''] }),
    ).toBe(buildBackgroundPrompt({ plan: PLAN_ZH, sceneType: 'photo', inventory: [] }))
    expect(buildBackgroundPrompt({ plan: PLAN_EN, sceneType: 'photo', language: 'en' })).toContain(
      'Untouched: the product itself and every part attached to it.',
    )
  })

  it('joins the inventory the way the prompt language writes a list', () => {
    expect(
      buildBackgroundPrompt({
        plan: PLAN_EN,
        sceneType: 'photo',
        language: 'en',
        inventory: INVENTORY_EN,
      }),
    ).toContain('Untouched: the bathtub, the floor-standing tap.')
    expect(
      buildBackgroundPrompt({ plan: PLAN_ZH, sceneType: 'photo', inventory: INVENTORY_ZH }),
    ).toContain('不动的部分：浴缸、落地龙头。')
  })

  it('names no part type of its own when the inventory is empty', () => {
    for (const mode of ['background', 'replace-product', 'replace-and-background'] as const) {
      for (const language of ['zh', 'en'] as const) {
        const prompt = buildBackgroundPrompt({
          plan: language === 'zh' ? PLAN_ZH : PLAN_EN,
          sceneType: 'photo',
          language,
          mode,
        })
        for (const part of HARD_CODED_PARTS) expect(prompt).not.toContain(part)
      }
    }
  })

  it('omits the preference clause when the preference is empty or blank (zh)', () => {
    expect(
      buildBackgroundPrompt({ plan: PLAN_ZH, sceneType: 'photo', language: 'zh' }),
    ).not.toContain('偏好')
    expect(
      buildBackgroundPrompt({
        plan: PLAN_ZH,
        sceneType: 'photo',
        preference: '   ',
        language: 'zh',
      }),
    ).toBe(buildBackgroundPrompt({ plan: PLAN_ZH, sceneType: 'photo', language: 'zh' }))
  })

  it('places a trimmed preference last, between the realism and quality clauses (zh)', () => {
    const prompt = buildBackgroundPrompt({
      plan: PLAN_ZH,
      sceneType: 'photo',
      preference: '  北欧风  ',
      language: 'zh',
      inventory: INVENTORY_ZH,
    })

    expect(prompt).toContain('北欧风')
    expect(prompt).not.toContain('  北欧风  ')
    expect(prompt.indexOf('真实房屋实拍')).toBeLessThan(prompt.indexOf('北欧风'))
    expect(prompt.indexOf('北欧风')).toBeLessThan(prompt.indexOf('写实商业摄影'))
  })

  it('builds an all-English prompt for the en language', () => {
    const prompt = buildBackgroundPrompt({
      plan: PLAN_EN,
      sceneType: 'photo',
      preference: 'Nordic',
      language: 'en',
    })

    expect(prompt).toContain('Untouched:')
    expect(prompt).toContain('To replace:')
    expect(prompt).toContain(PLAN_EN)
    expect(prompt).toContain('real home photographed on location')
    expect(prompt).toContain('Nordic')
    expect(prompt).toContain('Realistic commercial photography, sharp and detailed')
    expect(prompt).not.toMatch(/[一-鿿]/)
  })

  /** 示意图上的「墙面」多半是版面，整片换掉会把说明一起吃了。 */
  it('asks for the original wall and counter to go only on a plain photo', () => {
    expect(buildBackgroundPrompt({ plan: PLAN_ZH, sceneType: 'photo' })).toContain(
      '墙面、半墙、台面与地面',
    )
    expect(buildBackgroundPrompt({ plan: PLAN_ZH, sceneType: 'infographic' })).not.toContain(
      '墙面、半墙、台面与地面',
    )
    expect(buildBackgroundPrompt({ plan: PLAN_EN, sceneType: 'photo', language: 'en' })).toContain(
      'walls, half walls, counters and floor',
    )
  })

  it('defaults to Chinese when no language is given', () => {
    expect(buildBackgroundPrompt({ plan: PLAN_ZH, sceneType: 'photo' })).toBe(
      buildBackgroundPrompt({ plan: PLAN_ZH, sceneType: 'photo', language: 'zh' }),
    )
  })

  it('falls back to the background-only prompt when no mode is given', () => {
    expect(buildBackgroundPrompt({ plan: PLAN_ZH, sceneType: 'photo' })).toBe(
      buildBackgroundPrompt({ plan: PLAN_ZH, sceneType: 'photo', mode: 'background' }),
    )
  })
})

describe('buildBackgroundPrompt in replace-product mode', () => {
  it('asks for the masked product to become the one in the second image and nothing else to move', () => {
    const prompt = buildBackgroundPrompt({
      plan: PLAN_ZH,
      sceneType: 'photo',
      mode: 'replace-product',
    })

    expect(prompt).toContain('把图1遮罩区域内的产品替换为图2里的产品')
    expect(prompt).toContain('角度、透视与画面比例')
    expect(prompt).toContain('颜色、材质')
    expect(prompt).toContain('遮罩以外的画面一律不变')
    expect(prompt).toContain('写实商业摄影，清晰锐利')
  })

  it('drops the background plan and the realism clause: the scene stays put', () => {
    const prompt = buildBackgroundPrompt({
      plan: PLAN_ZH,
      sceneType: 'photo',
      preference: '北欧风',
      mode: 'replace-product',
    })

    expect(prompt).not.toContain(PLAN_ZH)
    expect(prompt).not.toContain('真实房屋实拍')
    expect(prompt).not.toContain('墙面、半墙、台面与地面')
    expect(prompt).not.toContain('北欧风')
  })

  it('builds an all-English prompt for the en language', () => {
    const prompt = buildBackgroundPrompt({
      plan: PLAN_EN,
      sceneType: 'photo',
      language: 'en',
      mode: 'replace-product',
    })

    expect(prompt).toContain('Replace the product inside the masked area of image 1')
    expect(prompt).not.toMatch(/[一-鿿]/)
  })
})

describe('buildBackgroundPrompt in replace-and-background mode', () => {
  it('treats the first image as framing only and keeps the background plan', () => {
    const prompt = buildBackgroundPrompt({
      plan: PLAN_ZH,
      sceneType: 'photo',
      preference: '北欧风',
      mode: 'replace-and-background',
    })

    expect(prompt).toContain('图1是构图参考')
    expect(prompt).toContain('图2里的产品')
    expect(prompt).toContain(PLAN_ZH)
    expect(prompt).toContain('真实房屋实拍')
    expect(prompt).toContain('北欧风')
    expect(prompt.indexOf('图1是构图参考')).toBeLessThan(prompt.indexOf(PLAN_ZH))
  })

  it('takes the product from the second image before the untouched section', () => {
    const prompt = buildBackgroundPrompt({
      plan: PLAN_ZH,
      sceneType: 'photo',
      mode: 'replace-and-background',
      inventory: INVENTORY_ZH,
    })

    expect(prompt.indexOf('图1是构图参考')).toBeLessThan(prompt.indexOf('不动的部分'))
    expect(prompt.indexOf('不动的部分：浴缸、落地龙头。')).toBeLessThan(
      prompt.indexOf('要换的部分'),
    )
  })

  it('builds an all-English prompt for the en language', () => {
    const prompt = buildBackgroundPrompt({
      plan: PLAN_EN,
      sceneType: 'photo',
      language: 'en',
      mode: 'replace-and-background',
    })

    expect(prompt).toContain('Image 1 is a framing reference')
    expect(prompt).toContain(PLAN_EN)
    expect(prompt).not.toMatch(/[一-鿿]/)
  })
})

describe('buildBackgroundPrompt product adherence', () => {
  /** 客户实拍：龙头被重画、缸体颗粒被抹平，不动的部分必须点名清单与表面纹理。 */
  it('names the inventory and the surface texture when the original product stays (zh)', () => {
    const prompt = buildBackgroundPrompt({
      plan: PLAN_ZH,
      sceneType: 'photo',
      inventory: INVENTORY_ZH,
    })

    expect(prompt).toContain('不动的部分：浴缸、落地龙头。')
    expect(prompt).toContain('表面纹理（颗粒、哑光、纹路）')
    expect(prompt).toContain('不得重画、不得平滑、不得改款')
  })

  it('asks for every part of the second image and its texture in both replace modes (zh)', () => {
    for (const mode of ['replace-product', 'replace-and-background'] as const) {
      const prompt = buildBackgroundPrompt({ plan: PLAN_ZH, sceneType: 'photo', mode })
      expect(prompt).toContain('图2产品连同它带的每一个部件')
      expect(prompt).toContain('表面纹理（颗粒、哑光、纹路）')
      expect(prompt).toContain('不得重画、不得平滑、不得改款')
    }
  })

  it('asks every mode for a sharp realistic photo instead of a smooth render (zh)', () => {
    for (const mode of ['background', 'replace-product', 'replace-and-background'] as const) {
      expect(buildBackgroundPrompt({ plan: PLAN_ZH, sceneType: 'photo', mode })).toContain(
        '写实商业摄影，清晰锐利，细节丰富，材质纹理可见，无过度平滑，无 CG 感，无文字无水印',
      )
    }
  })

  it('keeps the adherence clauses English in the en templates', () => {
    for (const mode of ['background', 'replace-product', 'replace-and-background'] as const) {
      const prompt = buildBackgroundPrompt({
        plan: PLAN_EN,
        sceneType: 'photo',
        language: 'en',
        mode,
      })
      expect(prompt).toContain('surface texture')
      expect(prompt).toContain('never repaint, never smooth, never restyle')
      expect(prompt).toContain('Realistic commercial photography')
      expect(prompt).not.toMatch(/[一-鿿]/)
    }
  })
})
