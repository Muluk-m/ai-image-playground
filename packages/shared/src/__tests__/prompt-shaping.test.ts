import { describe, expect, it } from 'bun:test'
import { buildAspectInstruction } from '../prompt-shaping'

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
