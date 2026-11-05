import { beforeAll, describe, expect, it } from 'bun:test'

process.env.DATABASE_URL ??= 'postgres://localhost/unused'
process.env.PORT ??= '0'

const { buildOpenAIBody } = await import('../../lib/upstream/openai')
const { config } = await import('../../config')

beforeAll(() => {
  config.gptImage26.svgModel = 'gpt-6-sol'
})

describe('gpt image 2.6 upstream body', () => {
  it('sends gif frame fields and does not attach an svg model', () => {
    const body = buildOpenAIBody('gpt-image-2.6-flare', {
      prompt: 'a paper crane',
      size: '768x768',
      quality: 'medium',
      output_format: 'gif',
      frame_count: 6,
      frame_duration_ms: 200,
      n: 1,
    })
    expect(body).toMatchObject({
      model: 'gpt-image-2.6-flare',
      output_format: 'gif',
      frame_count: 6,
      frame_duration_ms: 200,
      n: 1,
    })
    expect(body).not.toHaveProperty('svg')
  })

  it('sends svg.model from the environment and forces a single image', () => {
    const body = buildOpenAIBody('gpt-image-2.6-sunburst', {
      prompt: 'a mug logo',
      output_format: 'svg',
      quality: 'medium',
      n: 1,
    })
    expect(body.svg).toEqual({ model: 'gpt-6-sol' })
    expect(body.n).toBe(1)
    expect(body).not.toHaveProperty('frame_count')
  })
})
