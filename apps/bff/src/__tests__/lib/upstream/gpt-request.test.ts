import { describe, expect, it } from 'bun:test'
import { PROMPT_REWRITE_GUARD_PREFIX } from '@image-playground/shared'
import { buildOpenAIBody, buildOpenAIEditFormData } from '../../../lib/upstream/openai'
import { adaptGptRequest } from '../../../lib/upstream/adapters/gpt-request'

const guard = `${PROMPT_REWRITE_GUARD_PREFIX}\n`
const original = '  a cat\nwith a blue background  '

describe('route-specific prompt rewrite guard', () => {
  it.each(['gpt-image-2.5-flare', 'gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'])(
    'keeps new %s direct prompts raw and removes legacy guards',
    (model) => {
      expect(adaptGptRequest('direct', model, { prompt: original, no_rewrite: true }).prompt).toBe(original)
      expect(adaptGptRequest('direct', model, { prompt: guard + original }).prompt).toBe(original)
    },
  )

  it.each([true, false])('preserves a literal user guard with explicit no_rewrite=%s', (no_rewrite) => {
    const prompt = guard + original
    expect(adaptGptRequest('direct', 'gpt-image-2.6-flare', { prompt, no_rewrite }).prompt).toBe(prompt)
  })

  it('keeps the gateway opt-out, legacy prefix and explicit user text intact', () => {
    const model = 'gpt-image-2.5-flare'
    expect(adaptGptRequest('sub2api', model, { prompt: original, no_rewrite: false }).prompt).toBe(original)
    expect(adaptGptRequest('sub2api', model, { prompt: original }).prompt).toBe(original)
    expect(adaptGptRequest('sub2api', model, { prompt: guard + original }).prompt).toBe(guard + original)
    expect(adaptGptRequest('sub2api', model, { prompt: guard + original, no_rewrite: true }).prompt).toBe(guard + guard + original)
  })

  it('does not mutate the queued request across direct and gateway attempts', () => {
    const request = { prompt: original, no_rewrite: true, size: '1280x720' }
    const model = 'gpt-image-2.5-flare'
    expect(adaptGptRequest('sub2api', model, request).prompt).toBe(
      `${guard}${original}\n\nComposition: a wide 16:9 landscape frame, horizontal orientation.`,
    )
    expect(adaptGptRequest('direct', model, request).prompt).toBe(original)
    expect(request.prompt).toBe(original)
  })

  it.each(['png', 'gif', 'svg'])('keeps %s direct wire prompts clean without changing quality', (output_format) => {
    const model = 'gpt-image-2.6-flare'
    const request = adaptGptRequest('direct', model, { prompt: guard + original, output_format, quality: 'auto' })
    expect(buildOpenAIBody(model, request)).toMatchObject({ prompt: original, quality: 'auto' })
    expect(buildOpenAIEditFormData(model, request).get('prompt')).toBe(original)
  })
})
