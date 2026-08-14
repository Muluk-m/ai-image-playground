import { describe, expect, it } from 'vitest'

import { countInputImages, inputImageMaxIdx } from '../../lib/request-helpers'

describe('countInputImages', () => {
  it('counts OpenAI input_images with legacy data URLs and blob refs', () => {
    const result = countInputImages('openai-compat', {
      input_images: ['data:image/png;base64,AAAA', { $blob: 1 }],
    })

    expect(result).toEqual({ kind: 'count', count: 2 })
    expect(inputImageMaxIdx(result)).toBe(1)
  })

  it('counts Gemini input_images with legacy data URLs and blob refs', () => {
    const result = countInputImages('gemini', {
      input_images: [{ $blob: 0 }, 'data:image/jpeg;base64,AAAA', { $blob: 2 }],
    })

    expect(result).toEqual({ kind: 'count', count: 3 })
  })

  it('preserves the legacy Gemini contents inlineData fallback', () => {
    expect(
      countInputImages('gemini', {
        contents: [
          { parts: [{ text: 'prompt' }, { inlineData: { mimeType: 'image/png' } }] },
          { parts: [{ inlineData: { mimeType: 'image/jpeg' } }] },
        ],
      }),
    ).toEqual({ kind: 'count', count: 2 })
  })

  it('preserves OpenAI multipart image as not archived when input_images is absent', () => {
    expect(countInputImages('openai-compat', { image: 'multipart-file' })).toEqual({
      kind: 'not_archived',
    })
  })

  it('returns none when no stored input images exist', () => {
    expect(countInputImages('openai-compat', {})).toEqual({ kind: 'none' })
    expect(countInputImages('gemini', { contents: [] })).toEqual({ kind: 'none' })
  })
})
