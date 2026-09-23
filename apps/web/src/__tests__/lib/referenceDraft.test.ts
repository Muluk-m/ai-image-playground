import { describe, expect, it } from 'vitest'
import { getSelectedImageMentionLabel } from '../../lib/promptImageMentions'
import {
  attachReferences,
  moveReference,
  type ReferenceAdmission,
  type ReferenceDraft,
  referenceRefusal,
  referenceTally,
  removeReference,
  replaceReferences,
} from '../../lib/referenceDraft'
import type { InputImage } from '../../types'

const OK = { limit: 3, acceptsReferences: true }
/** 分两档发的那一头：条一共放 5 张，其中只能内联字节的最多 2 张。 */
const TWO_TIER: ReferenceAdmission = {
  limit: 5,
  acceptsReferences: true,
  inline: { limit: 2, sendsById: (one) => one.dataUrl.startsWith('aip-media:') },
}
const mention = getSelectedImageMentionLabel

function draft(ids: string[], prompt = ''): ReferenceDraft<InputImage> {
  return { prompt, references: ids.map((id) => ({ id, dataUrl: `data:,${id}` })) }
}

function image(id: string): InputImage {
  return { id, dataUrl: `data:,${id}` }
}

/** 一张按 id 发的图：字节不进请求体，不占内联名额。 */
function byId(id: string): InputImage {
  return { id, dataUrl: `aip-media:${id}` }
}

describe('往参考图草稿里附图', () => {
  it('一组图按序进条，返回每张的序号', () => {
    const result = attachReferences(draft(['a']), [image('b'), image('c')], OK)

    expect(result.ok && result.draft.references.map((one) => one.id)).toEqual(['a', 'b', 'c'])
    expect(result.ok && result.indexes).toEqual([1, 2])
  })

  it('同一张图只占一位，复用原序号', () => {
    const result = attachReferences(draft(['a', 'b']), [image('b')], OK)

    expect(result.ok && result.indexes).toEqual([1])
    expect(result.ok && result.draft.references).toHaveLength(2)
  })

  it('放不下就整组不落，条原样留着', () => {
    const before = draft(['a', 'b'])

    const result = attachReferences(before, [image('c'), image('d')], OK)

    expect(result).toEqual({ ok: false, reason: 'overflow' })
    expect(before.references.map((one) => one.id)).toEqual(['a', 'b'])
  })

  it('模型不认参考图就一张都不附', () => {
    const result = attachReferences(draft([]), [image('a')], { limit: 3, acceptsReferences: false })

    expect(result).toEqual({ ok: false, reason: 'noEdit' })
  })

  it('整组都已在条里时，不认参考图的模型也不拦——这一次没往条里加东西', () => {
    const before = draft(['a'])

    const result = attachReferences(before, [image('a')], { limit: 1, acceptsReferences: false })

    expect(result.ok && result.indexes).toEqual([0])
    expect(result.ok && result.draft).toBe(before)
  })

  it('改图这一次不吃去重的豁免：那张图早在条里，模型不认参考图也不给改', () => {
    const before = draft(['a'])

    const result = attachReferences(before, [image('a')], {
      limit: 1,
      acceptsReferences: false,
      intent: 'edit',
    })

    expect(result).toEqual({ ok: false, reason: 'noEdit' })
  })

  it('草稿自己带的别的东西原样留着：智能体草稿的创作类型不能在附图时掉了', () => {
    const before = { ...draft([]), mode: 'image' as const }

    const result = attachReferences(before, [image('a')], OK)

    expect(result.ok && result.draft.mode).toBe('image')
  })
})

describe('两档上限：按 id 发的与只能内联的', () => {
  const inlineFull: ReferenceDraft<InputImage> = {
    prompt: '',
    references: [image('a'), image('b')],
  }

  it('按 id 发的不占内联名额：内联那道满了也拦不住它', () => {
    const result = attachReferences(inlineFull, [byId('m1')], TWO_TIER)

    expect(result.ok && result.draft.references.map((one) => one.id)).toEqual(['a', 'b', 'm1'])
  })

  it('只能内联的撞内联那道，报的是内联那道——调用方据此说对是哪一句', () => {
    const result = attachReferences(inlineFull, [image('c')], TWO_TIER)

    expect(result).toEqual({ ok: false, reason: 'inlineOverflow' })
  })

  it('一轮总数先判：按 id 发的再多也放不下第 6 张', () => {
    const full = { prompt: '', references: ['m1', 'm2', 'm3', 'm4', 'm5'].map(byId) }

    expect(attachReferences(full, [byId('m6')], TWO_TIER)).toEqual({
      ok: false,
      reason: 'overflow',
    })
  })
})

describe('图还没落盘时先问一次准入', () => {
  it('这一把放不下就整把不收，放得下才让调用方去取图', () => {
    expect(referenceRefusal({ total: 2 }, { total: 2 }, OK)).toBe('overflow')
    expect(referenceRefusal({ total: 2 }, { total: 1 }, OK)).toBeNull()
  })

  it('模型不认参考图：要新加就不收，一张都不打算加时不拦', () => {
    expect(
      referenceRefusal({ total: 0 }, { total: 1 }, { limit: 3, acceptsReferences: false }),
    ).toBe('noEdit')
    expect(
      referenceRefusal({ total: 1 }, { total: 0 }, { limit: 3, acceptsReferences: false }),
    ).toBeNull()
  })

  it('不报内联张数就按全都要内联算：拖进来的一把文件正是如此', () => {
    const attached = referenceTally([byId('m1'), image('a')], TWO_TIER)

    expect(attached).toEqual({ total: 2, inline: 1 })
    expect(referenceRefusal(attached, { total: 2 }, TWO_TIER)).toBe('inlineOverflow')
  })
})

describe('整条换掉参考图草稿', () => {
  it('不给提示词就留着原来那句，引用按新顺序重排', () => {
    const before = draft(['a', 'b'], `${mention(0)} 与 ${mention(1)}`)

    const after = replaceReferences(before, [image('b'), image('a')])

    expect(after.prompt).toBe(`${mention(1)} 与 ${mention(0)}`)
  })

  it('给了提示词就原样收下：那句话本来就是按新这条的序号写的', () => {
    const before = draft(['x'], `旧的 ${mention(0)}`)

    const after = replaceReferences(before, [image('a'), image('b')], {
      prompt: `复用 ${mention(1)}`,
    })

    expect(after).toEqual({
      prompt: `复用 ${mention(1)}`,
      references: [image('a'), image('b')],
    })
  })

  it('换掉的图认作同一位时引用跟着走', () => {
    const before = draft(['a', 'b'], `参考 ${mention(0)}`)

    const after = replaceReferences(before, [image('a-masked'), image('b')], {
      equivalentImageIds: { a: 'a-masked' },
    })

    expect(after.prompt).toBe(`参考 ${mention(0)}`)
  })

  it('清空时引用降级为一段普通文字', () => {
    const after = replaceReferences(draft(['a'], `放进 ${mention(0)}`), [])

    expect(after.prompt).toBe('放进 @已移除图片')
    expect(after.references).toEqual([])
  })
})

describe('拿掉与挪动参考图', () => {
  it('拿掉一张，指向它的引用降级，其余跟着新序号走', () => {
    const before = draft(['a', 'b', 'c'], `${mention(0)} 与 ${mention(1)} 与 ${mention(2)}`)

    const after = removeReference(before, 1)

    expect(after.references.map((one) => one.id)).toEqual(['a', 'c'])
    expect(after.prompt).toBe(`${mention(0)} 与 @已移除图片 与 ${mention(1)}`)
  })

  it('挪到前面，引用跟着图走', () => {
    const before = draft(['a', 'b'], `${mention(0)} 站在 ${mention(1)} 前`)

    const after = moveReference(before, 1, 0)

    expect(after.references.map((one) => one.id)).toEqual(['b', 'a'])
    expect(after.prompt).toBe(`${mention(1)} 站在 ${mention(0)} 前`)
  })

  it('落回原位就是没动过，草稿原样返回', () => {
    const before = draft(['a', 'b'])

    expect(moveReference(before, 0, 1)).toBe(before)
    expect(moveReference(before, 5, 0)).toBe(before)
  })
})
