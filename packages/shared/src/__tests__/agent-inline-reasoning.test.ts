import { describe, expect, it } from 'bun:test'
import { splitInlineReasoning, stripInlineReasoning } from '../agent-inline-reasoning'

describe('splitInlineReasoning', () => {
  it('splits a closed leading block into reasoning and reply', () => {
    expect(splitInlineReasoning('<thinking>读画布</thinking>\n\n已开始出图。')).toEqual({
      state: 'reasoning',
      thinking: '读画布',
      text: '已开始出图。',
      closed: true,
    })
    expect(splitInlineReasoning('  <THINK >plan</think >ok')).toEqual({
      state: 'reasoning',
      thinking: 'plan',
      text: 'ok',
      closed: true,
    })
  })

  it('treats an unclosed leading block as reasoning to the end', () => {
    expect(splitInlineReasoning('<thinking>Launching image generation node')).toEqual({
      state: 'reasoning',
      thinking: 'Launching image generation node',
      text: '',
      closed: false,
    })
  })

  it('leaves tags in the middle of the reply untouched', () => {
    const text = '好的。<thinking>这是正文里的字</thinking>后面的内容还在'
    expect(splitInlineReasoning(text)).toEqual({ state: 'plain', text })
    expect(stripInlineReasoning(text)).toBe(text)
    expect(stripInlineReasoning('说明：<think>没有闭合，后面也不能吞')).toBe(
      '说明：<think>没有闭合，后面也不能吞',
    )
  })

  it('only knows the configured tags', () => {
    expect(splitInlineReasoning('<b>粗体</b>')).toEqual({ state: 'plain', text: '<b>粗体</b>' })
    expect(splitInlineReasoning('<think>x</think>y', ['thinking'])).toEqual({
      state: 'plain',
      text: '<think>x</think>y',
    })
  })

  it('waits while the start could still become a tag, then decides', () => {
    for (const partial of ['', '  ', '<', '<thi', '<think', '<thinking ']) {
      expect(splitInlineReasoning(partial, undefined, false)).toEqual({ state: 'pending' })
    }
    expect(splitInlineReasoning('<thx', undefined, false)).toEqual({ state: 'plain', text: '<thx' })
    expect(splitInlineReasoning('<thi', undefined, true)).toEqual({ state: 'plain', text: '<thi' })
  })

  it('holds back a half-written closing tag while streaming', () => {
    expect(splitInlineReasoning('<thinking>abc</thi', undefined, false)).toMatchObject({
      thinking: 'abc',
      closed: false,
    })
    expect(splitInlineReasoning('<thinking>a < b', undefined, false)).toMatchObject({
      thinking: 'a < b',
    })
  })

  it('grows monotonically chunk by chunk', () => {
    const full = '<thinking>Reading canvas </thinking>\n已开始出图，<b>稍等</b>。'
    let thinking = ''
    let text = ''
    for (let end = 0; end <= full.length; end++) {
      const split = splitInlineReasoning(full.slice(0, end), undefined, end === full.length)
      if (split.state === 'pending') continue
      const nextThinking = split.state === 'reasoning' ? split.thinking : ''
      expect(nextThinking.startsWith(thinking)).toBe(true)
      expect(split.text.startsWith(text)).toBe(true)
      thinking = nextThinking
      text = split.text
    }
    expect(thinking).toBe('Reading canvas ')
    expect(text).toBe('已开始出图，<b>稍等</b>。')
  })
})
