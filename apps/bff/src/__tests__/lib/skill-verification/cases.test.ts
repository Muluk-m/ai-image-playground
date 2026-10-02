import { describe, expect, it } from 'bun:test'
import {
  caseTurn,
  declaredInputs,
  parseVerificationCases,
  resolveFixture,
} from '../../../lib/skill-verification/cases'

const PRODUCT = { key: 'product', required: true, multiple: true }
const MODEL = { key: 'model', required: false, multiple: false }

const existing = new Set(['/skill-verification/fixtures/mug.webp', '/skill/verification/own.png'])
const locate = (ref: string) => resolveFixture('/skills', '/skill', ref)
const exists = (path: string) => existing.has(path)

function caseOf(
  id: string,
  prompt = '用 {product} 出一张主图',
  inputs: Record<string, string[]> = { product: ['shared:mug.webp'] },
) {
  return { id, prompt, inputs }
}

describe('declaredInputs', () => {
  const flags = (inputs: readonly { key: string; required: boolean; multiple: boolean }[]) =>
    inputs.map(({ key, required, multiple }) => ({ key, required, multiple }))

  it('写了 inputs 用它，required 缺省为必填、multiple 缺省为单图，坏条目丢掉', () => {
    const inputs = declaredInputs(
      {
        inputs: [
          { key: 'product', label: { 'zh-CN': '商品' } },
          { key: 'model', label: { 'zh-CN': '模特' }, required: false, multiple: true },
          { key: 'Bad Key', label: { 'zh-CN': '坏' } },
        ],
        template: { slotCount: 3 },
      },
      'fixture-skill',
    )
    expect(flags(inputs)).toEqual([
      { key: 'product', required: true, multiple: false },
      { key: 'model', required: false, multiple: true },
    ])
  })

  it('预置模板没写 inputs 时按 slotCount 派生 asset1..N', () => {
    expect(
      declaredInputs({ template: { slotCount: 2 } }, 'fixture-skill').map((one) => one.key),
    ).toEqual(['asset1', 'asset2'])
  })

  it('普通技能什么都没写就没有位', () => {
    expect(declaredInputs({ icon: 'x' }, 'fixture-skill')).toEqual([])
    expect(declaredInputs(null, 'fixture-skill')).toEqual([])
  })
})

describe('parseVerificationCases', () => {
  it('3 组合法输入通过，公共素材与技能自带素材都能解析', () => {
    const raw = {
      cases: [
        caseOf('a'),
        caseOf('b', '{product} 换到海边', { product: ['own.png'] }),
        caseOf('c', '{product} 和 {model}', { product: ['shared:mug.webp'], model: ['own.png'] }),
      ],
    }
    expect(parseVerificationCases(raw, [PRODUCT, MODEL], locate, exists)).toEqual({
      ok: true,
      cases: raw.cases,
    })
  })

  it('组数不对、id 重复、文件缺失、未声明的位、缺必填位都报错', () => {
    const parsed = parseVerificationCases(
      {
        cases: [
          caseOf('a'),
          caseOf('a', '{product}', { product: ['shared:missing.webp'] }),
          caseOf('c', '{other}', { other: ['own.png'] } as never),
          caseOf('d', '/poster {product}', { product: ['../escape.webp'] }),
        ],
      },
      [PRODUCT],
      locate,
      exists,
    )
    expect(parsed.ok).toBe(false)
    if (!parsed.ok)
      expect(parsed.errors).toEqual([
        '需要 3 组测试输入，写了 4 组',
        'cases[1].id 重复：a',
        'cases[1].inputs.product 里的 shared:missing.webp 不存在',
        'cases[2].inputs 缺必填位 product',
        'cases[2].inputs.other 不是这条技能声明的位',
        'cases[3].prompt 不要带 /技能名，跑图脚本会加',
        'cases[3].inputs.product 里的 ../escape.webp 不是合法的图片文件名',
      ])
  })

  it('单图位放了两张、给了图却没在 prompt 里用、prompt 引用了没给图的位都报错', () => {
    const parsed = parseVerificationCases(
      {
        cases: [
          caseOf('a', '{product}', { product: ['shared:mug.webp'], model: ['own.png', 'own.png'] }),
          caseOf('b', '{product} {model}'),
          caseOf('c'),
        ],
      },
      [PRODUCT, MODEL],
      locate,
      exists,
    )
    expect(parsed.ok).toBe(false)
    if (!parsed.ok)
      expect(parsed.errors).toEqual([
        'cases[0].prompt 没有用到位 {model}',
        'cases[0].inputs.model 这个位只收一张图',
        'cases[1].prompt 引用了没给图的位 {model}',
      ])
  })

  it('没有 cases 数组直接拒绝', () => {
    expect(parseVerificationCases([], [PRODUCT], locate, exists).ok).toBe(false)
  })
})

describe('caseTurn', () => {
  it('按位顺序编号，{key} 换成该位全部 [image N]', () => {
    expect(
      caseTurn('product-main-image', {
        id: 'a',
        prompt: ' 把 {model} 和 {product} 放一起 ',
        inputs: { product: ['shared:mug.webp', 'own.png'], model: ['m.webp'] },
      }),
    ).toEqual({
      text: '/product-main-image 把 [image 3] 和 [image 1] [image 2] 放一起',
      images: [
        { key: 'product', ref: 'shared:mug.webp' },
        { key: 'product', ref: 'own.png' },
        { key: 'model', ref: 'm.webp' },
      ],
    })
  })
})
