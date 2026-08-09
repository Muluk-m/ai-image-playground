import { describe, expect, it } from 'vitest'
import { countInputImages, inputImageMaxIdx } from '../../lib/request-helpers'

describe('countInputImages', () => {
  it('counts archived input references and a mask in BFF resolver order', () => {
    const count = countInputImages('openai-compat', {
      input_images: [
        { object: 'task-1/in/0', mime: 'image/png' },
        { object: 'task-1/in/1', mime: 'image/jpeg' },
      ],
      mask: { object: 'task-1/in/2', mime: 'image/png' },
    })

    expect(count).toEqual({ kind: 'count', count: 3 })
    expect(inputImageMaxIdx(count)).toBe(2)
  })

  it('prefers archived references over legacy Gemini inline data', () => {
    expect(
      countInputImages('gemini', {
        input_images: [{ object: 'task-2/in/0', mime: 'image/png' }],
        contents: [
          { parts: [{ inlineData: { mimeType: 'image/png', data: 'legacy-1' } }] },
          { parts: [{ inlineData: { mimeType: 'image/png', data: 'legacy-2' } }] },
        ],
      }),
    ).toEqual({ kind: 'count', count: 1 })
  })
})
