import { describe, expect, it } from 'bun:test'
import {
  applyPromptRewriteGuard,
  buildAspectInstruction,
  unshapeQueuePrompt,
} from '../prompt-shaping'

describe('buildAspectInstruction', () => {
  it('builds a portrait composition sentence from a parseable size', () => {
    const expected = 'Composition: a tall 9:16 vertical frame, portrait orientation.'

    expect(buildAspectInstruction('1024x1824')).toBe(expected)
    expect(buildAspectInstruction(' 1024 × 1824 ')).toBe(expected)
  })

  it('returns null for auto size', () => {
    expect(buildAspectInstruction('auto')).toBeNull()
  })
})

describe('unshapeQueuePrompt', () => {
  it('removes exact machine instructions while preserving the original text', () => {
    const original = '  Product photo\nwith a blue background  '
    const shaped = `${applyPromptRewriteGuard(original)}\n\n${buildAspectInstruction('1024x1536')}`
    expect(unshapeQueuePrompt({ prompt: shaped, size: '1024x1536' })).toBe(original)
  })

  it('preserves unshaped text and mismatched aspect instructions', () => {
    const prompt = 'A landscape\n\nComposition: a 1:1 square frame.'
    expect(unshapeQueuePrompt({ prompt, size: '1024x1536' })).toBe(prompt)
    expect(unshapeQueuePrompt({ prompt: 'Video prompt' })).toBe('Video prompt')
  })
})
