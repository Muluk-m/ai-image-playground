import { describe, expect, it } from 'bun:test'
import { buildBackgroundPrompt } from '../../lib/bgswapPrompt'

const PLAN_ZH = '暖白微水泥墙面，浅橡木地板，左侧柔和窗光，一株散尾葵与一条亚麻毛巾。'
const PLAN_EN = 'Warm microcement wall, pale oak floor, soft window light from the left, one palm.'

describe('buildBackgroundPrompt', () => {
  it('keeps the product lock, the plan, the realism and the quality clause in order (zh)', () => {
    const prompt = buildBackgroundPrompt({ plan: PLAN_ZH, sceneType: 'photo', language: 'zh' })

    expect(prompt).toContain('严格保留图中产品本身')
    expect(prompt).toContain(PLAN_ZH)
    expect(prompt).toContain('真实房屋实拍')
    expect(prompt).toContain('商业产品摄影，无文字无水印')
    expect(prompt.indexOf('严格保留图中产品本身')).toBeLessThan(prompt.indexOf(PLAN_ZH))
    expect(prompt.indexOf(PLAN_ZH)).toBeLessThan(prompt.indexOf('真实房屋实拍'))
    expect(prompt.indexOf('真实房屋实拍')).toBeLessThan(prompt.indexOf('商业产品摄影'))
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

  it('places a trimmed preference between the realism and quality clauses (zh)', () => {
    const prompt = buildBackgroundPrompt({
      plan: PLAN_ZH,
      sceneType: 'photo',
      preference: '  北欧风  ',
      language: 'zh',
    })

    expect(prompt).toContain('北欧风')
    expect(prompt).not.toContain('  北欧风  ')
    expect(prompt.indexOf('真实房屋实拍')).toBeLessThan(prompt.indexOf('北欧风'))
    expect(prompt.indexOf('北欧风')).toBeLessThan(prompt.indexOf('商业产品摄影'))
  })

  it('builds an all-English prompt for the en language', () => {
    const prompt = buildBackgroundPrompt({
      plan: PLAN_EN,
      sceneType: 'photo',
      preference: 'Nordic',
      language: 'en',
    })

    expect(prompt).toContain('Keep the product in the image exactly as it is')
    expect(prompt).toContain(PLAN_EN)
    expect(prompt).toContain('real home photographed on location')
    expect(prompt).toContain('Nordic')
    expect(prompt).toContain('Commercial product photography, no text, no watermark')
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
})
