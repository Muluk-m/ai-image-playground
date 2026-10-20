import { describe, expect, it } from 'vitest'
import {
  plainPrompt,
  promptHasArguments,
  promptSegments,
} from '../../../../features/inspiration/lib/promptArgs'

describe('prompt arguments', () => {
  const raw =
    '主角是 {argument name="subject" default="[NAME]"}，穿着 {argument name="dress" default="简约的白色短裙"}。'

  it('highlights the default and substitutes it for copy and apply', () => {
    expect(plainPrompt(raw)).toBe('主角是 [NAME]，穿着 简约的白色短裙。')
    expect(promptHasArguments(raw)).toBe(true)
    expect(promptSegments(raw).filter((segment) => segment.type === 'arg')).toEqual([
      { type: 'arg', text: '[NAME]', name: 'subject' },
      { type: 'arg', text: '简约的白色短裙', name: 'dress' },
    ])
  })

  it('leaves a prompt without placeholders unchanged', () => {
    expect(plainPrompt('plain')).toBe('plain')
    expect(promptHasArguments('plain')).toBe(false)
  })
})
