import { describe, expect, it } from 'bun:test'
import { InlineThinkingFilter, stripInlineThinking } from '../agent-inline-thinking'

function stream(chunks: readonly string[]) {
  const filter = new InlineThinkingFilter()
  return chunks.map((chunk) => filter.push(chunk)).join('') + filter.end()
}

describe('inline thinking', () => {
  it('drops a closed thinking block', () => {
    expect(
      stripInlineThinking(
        '<thinking>Reading canvas to confirm node names and range before running</thinking>',
      ),
    ).toBe('')
    expect(stripInlineThinking('<think>plan</think>\n已开始出图。')).toBe('已开始出图。')
  })

  it('drops an unclosed block up to the end of the message', () => {
    expect(stripInlineThinking('<thinking>Launching image generation node')).toBe('')
    expect(stripInlineThinking('好的。<THINKING >still going')).toBe('好的。')
  })

  it('handles tags split across deltas', () => {
    expect(stream(['前', '<thi', 'nking>Reading', ' canvas</thi', 'nking>后'])).toBe('前后')
    expect(stream(['<', 'think>', 'x', '</', 'think', '>', 'ok'])).toBe('ok')
  })

  it('keeps ordinary angle brackets and text', () => {
    expect(stream(['a < b', '，<', 'b>粗体</b>'])).toBe('a < b，<b>粗体</b>')
    expect(stream(['结尾是 <'])).toBe('结尾是 <')
    expect(stripInlineThinking('没有标签')).toBe('没有标签')
  })
})
