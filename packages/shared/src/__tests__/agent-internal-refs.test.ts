import { describe, expect, it } from 'bun:test'
import { stripInternalRefs } from '../agent-internal-refs'

const ID = 'agent_a174c2bd-5f3b-4b50-889e-acc7f8bb69af_0'

describe('stripInternalRefs', () => {
  it('removes a known item key in brackets and backticks (BUG-56)', () => {
    expect(
      stripInternalRefs(
        '这一批 2 张都已完成，没有缺的；兔子图（`animal-03-rabbit`）是在你确认前删掉的。',
        ['animal-01-cat', 'animal-03-rabbit'],
      ),
    ).toBe('这一批 2 张都已完成，没有缺的；兔子图是在你确认前删掉的。')
    expect(stripInternalRefs('补做兔子图（animal-03-rabbit）', ['animal-03-rabbit'])).toBe(
      '补做兔子图',
    )
  })

  it('removes artifact ids and bare uuids, keeps image and link markdown', () => {
    expect(stripInternalRefs(`小猫（${ID}）已完成`)).toBe('小猫已完成')
    expect(stripInternalRefs('批次 8e6eb54c-0000-4000-8000-000000000000 已完成')).toBe(
      '批次 已完成',
    )
    expect(stripInternalRefs(`![小猫](${ID})`)).toBe(`![小猫](${ID})`)
    expect(stripInternalRefs(`- [小狗](${ID})`)).toBe(`- [小狗](${ID})`)
  })

  it('only drops plain-word keys when bracketed or ticked', () => {
    expect(stripInternalRefs('小猫（cat）和 `dog`，cat 很可爱', ['cat', 'dog'])).toBe(
      '小猫和，cat 很可爱',
    )
    expect(stripInternalRefs('用 cat-2 做参考', ['cat-2'])).toBe('用 做参考')
  })

  it('does not cut into longer words or other identifiers', () => {
    expect(stripInternalRefs('模型 gpt-image-2 很快', ['image-2'])).toBe('模型 gpt-image-2 很快')
    expect(stripInternalRefs('没有内部标识的话', ['x'])).toBe('没有内部标识的话')
  })
})
