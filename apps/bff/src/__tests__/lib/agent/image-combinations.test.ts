import { describe, expect, it } from 'bun:test'
import type { AgentContentBlock, AgentMessageView } from '@image-playground/shared'
import { createImageCombinationGuard } from '../../../lib/agent/image-combinations'

function assistant(content: AgentContentBlock[]): AgentMessageView {
  return { id: crypto.randomUUID(), turnId: 'previous', role: 'assistant', createdAt: 1, content }
}
function edited(ids: string[]): AgentMessageView {
  return assistant([
    {
      type: 'toolResult',
      toolName: 'editImage',
      toolCallId: 'edit',
      title: '改图',
      status: 'succeeded',
      job: { media: 'image', taskId: 'task' },
      snapshot: { mode: 'image', args: {}, imageIds: ids },
    },
  ])
}
const original = edited(['scene', 'old-product'])
function guard(history = [original], ids = ['a', 'b']) {
  return createImageCombinationGuard({
    history,
    references: ids.map((imageId) => ({ imageId })),
    text: '这些也是',
    hasNewReferences: true,
  })
}
function chosen(separate: boolean, trailing = false) {
  const asked = guard().inspect(['scene', 'a', 'b'])!
  return createImageCombinationGuard({
    history: [
      original,
      assistant([asked]),
      ...(trailing
        ? [
            assistant([
              {
                type: 'toolResult',
                toolCallId: 'blocked',
                toolName: 'editImage',
                title: '等待确认图片组合',
                status: 'succeeded',
              },
            ]),
          ]
        : []),
    ],
    references: [{ imageId: 'a' }, { imageId: 'b' }],
    text: asked.options[separate ? 0 : 1]!,
    hasNewReferences: false,
  })
}

describe('image combination execution scope', () => {
  it('lets separate new products reuse a scene without asking', () => {
    const scope = guard()
    expect(scope.inspect(['scene', 'a'])).toBeUndefined()
    expect(scope.inspect(['scene', 'b'])).toBeUndefined()
  })
  it('does not reinterpret a first multi-reference edit or a different target', () => {
    expect(guard([]).inspect(['scene', 'a', 'b'])).toBeUndefined()
    expect(guard().inspect(['another-scene', 'a', 'b'])).toBeUndefined()
  })
  it('keeps all later image calls blocked after asking', () => {
    const scope = guard()
    const asked = scope.inspect(['scene', 'a', 'b'])
    expect(asked?.imageCombination?.referenceImageIds).toEqual(['a', 'b'])
    expect(scope.inspect(['scene', 'a'])).toBe(asked)
    expect(scope.inspect([])).toBe(asked)
  })
  it('asks only about participating new references even if the scene and other images are reattached', () => {
    const asked = guard([original], ['scene', 'old-product', 'a', 'b', 'unrelated']).inspect([
      'scene',
      'a',
      'b',
    ])
    expect(asked?.imageCombination?.referenceImageIds).toEqual(['a', 'b'])
  })
  it('uses the latest edit of this target, not an unrelated target or an outdated reference count', () => {
    expect(
      guard([original, edited(['other', 'other-product'])]).inspect(['scene', 'a', 'b']),
    ).toBeDefined()
    expect(
      guard([original, edited(['scene', 'older-a', 'older-b'])]).inspect(['scene', 'a', 'b']),
    ).toBeUndefined()
  })
  it('preserves the selected mapping after later blocked tool cards', () => {
    const scope = chosen(true, true)
    expect(() => scope.inspect(['scene', 'a', 'b'])).toThrow('分别生成')
    expect(scope.inspect(['scene', 'a'])).toBeUndefined()
    expect(scope.inspect(['scene', 'b'])).toBeUndefined()
    expect(() => scope.inspect(['a', 'b'])).toThrow('分别生成')
    expect(() => scope.inspect([])).toThrow('分别生成')
  })
  it('enforces the explicitly selected output count and consumes only successful operations', () => {
    const scope = chosen(true)
    expect(() => scope.inspect(['scene', 'a'], 2)).toThrow('只生成1张')
    expect(scope.inspect(['scene', 'a'])).toBeUndefined()
    expect(scope.inspect(['scene', 'a'])).toBeUndefined()
    scope.submitted(['scene', 'a'])
    expect(() => scope.inspect(['scene', 'a'])).toThrow('不可重复生成')
    expect(scope.inspect(['scene', 'b'])).toBeUndefined()
  })
  it('allows an explicitly selected joint reference and rejects a partial replacement', () => {
    const scope = chosen(false)
    expect(scope.inspect(['scene', 'a', 'b'])).toBeUndefined()
    expect(() => scope.inspect(['scene', 'a'])).toThrow('共同参考')
    scope.submitted(['scene', 'a', 'b'])
    expect(() => scope.inspect(['scene', 'a', 'b'])).toThrow('不可重复生成')
  })
  it('retains fixed references and their order in both separate and joint combinations', () => {
    const ids = ['scene', 'a', 'old-product', 'b']
    const asked = guard().inspect(ids)!
    for (const separate of [true, false]) {
      const scope = createImageCombinationGuard({
        history: [original, assistant([asked])],
        references: [{ imageId: 'a' }, { imageId: 'b' }],
        text: asked.options[separate ? 0 : 1]!,
        hasNewReferences: false,
      })
      const expected = separate
        ? [
            ['scene', 'a', 'old-product'],
            ['scene', 'old-product', 'b'],
          ]
        : [ids]
      for (const combination of expected) expect(scope.inspect(combination)).toBeUndefined()
      expect(() => scope.inspect(['scene', 'a', 'b'])).toThrow()
    }
  })
  it('updates references when an interjection is accepted and revokes the old approval', () => {
    const scope = chosen(true)
    scope.interjected([{ imageId: 'c' }, { imageId: 'd' }])
    expect(scope.inspect(['scene', 'c', 'd'])?.imageCombination?.referenceImageIds).toEqual([
      'c',
      'd',
    ])
    const changed = chosen(true)
    changed.interjected([])
    expect(changed.inspect(['scene', 'a', 'b'])?.imageCombination).toBeDefined()
  })
})
