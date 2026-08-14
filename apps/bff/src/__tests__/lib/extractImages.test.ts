import { describe, expect, it } from 'bun:test'
import { Buffer } from 'node:buffer'
import {
  externalizeResultImages,
  extractMeta,
  markResultImagesDropped,
  resolveImageBytesRef,
} from '../../lib/extractImages'

describe('result image externalization', () => {
  it('externalizes OpenAI base64 entries while preserving URL refs and provider metadata', () => {
    const payload = {
      created: 123,
      size: '1024x1024',
      quality: 'high',
      output_format: 'png',
      data: [
        { b64_json: Buffer.from('first').toString('base64'), revised_prompt: 'one' },
        { url: 'https://images.example/two.png', revised_prompt: 'two' },
        { ignored: true },
        { b64_json: Buffer.from('third').toString('base64') },
      ],
    }

    const expectedImages = [
      { index: 0, mime: 'image/png', revised_prompt: 'one' },
      { index: 1, mime: 'image/png', revised_prompt: 'two' },
      { index: 2, mime: 'image/png' },
    ]
    const externalized = externalizeResultImages('openai-compat', payload)
    expect(
      externalized.blobs.map(({ kind, idx, mime, data }) => ({
        kind,
        idx,
        mime,
        data: data.toString(),
      })),
    ).toEqual([
      { kind: 'output', idx: 0, mime: 'image/png', data: 'first' },
      { kind: 'output', idx: 2, mime: 'image/png', data: 'third' },
    ])
    expect(externalized.payload).toMatchObject({
      created: 123,
      data: [
        { revised_prompt: 'one' },
        { url: 'https://images.example/two.png', revised_prompt: 'two' },
        { ignored: true },
        {},
      ],
      _image_meta: expectedImages,
    })

    const meta = extractMeta('openai-compat', externalized.payload)
    expect(meta).toEqual({
      images: expectedImages,
      raw_image_urls: ['https://images.example/two.png'],
      actual_params: { size: '1024x1024', quality: 'high', output_format: 'png' },
    })
    expect(resolveImageBytesRef('openai-compat', externalized.payload, 1)).toEqual({
      kind: 'url',
      data: 'https://images.example/two.png',
      mime: 'image/png',
    })
  })

  it('externalizes Gemini inline data with normalized indexes and preserves text metadata', () => {
    const payload = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: 'revised prompt' },
              {
                inlineData: {
                  mimeType: 'image/jpeg',
                  data: Buffer.from('jpeg').toString('base64'),
                },
              },
              { text: 'second line' },
              {
                inlineData: { mimeType: 'image/png', data: Buffer.from('png').toString('base64') },
              },
            ],
          },
        },
      ],
    }

    const expectedImages = [
      { index: 0, mime: 'image/jpeg', revised_prompt: 'revised prompt\nsecond line' },
      { index: 1, mime: 'image/png', revised_prompt: 'revised prompt\nsecond line' },
    ]
    const externalized = externalizeResultImages('gemini', payload)
    expect(
      externalized.blobs.map(({ idx, mime, data }) => ({ idx, mime, data: data.toString() })),
    ).toEqual([
      { idx: 0, mime: 'image/jpeg', data: 'jpeg' },
      { idx: 1, mime: 'image/png', data: 'png' },
    ])
    expect(externalized.payload).toMatchObject({
      _image_meta: expectedImages,
      candidates: [
        {
          content: {
            parts: [
              { text: 'revised prompt' },
              { inlineData: { mimeType: 'image/jpeg' } },
              { text: 'second line' },
              { inlineData: { mimeType: 'image/png' } },
            ],
          },
        },
      ],
    })
    expect(extractMeta('gemini', externalized.payload).images).toEqual(expectedImages)
  })

  it('marks discarded images without retaining pixel bytes', () => {
    const dropped = markResultImagesDropped({
      data: [{ b64_json: Buffer.from('pixel').toString('base64') }],
      candidates: [
        { content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'pixel' } }] } },
      ],
    })
    expect(dropped).toEqual({
      data: [{}],
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png' } }] } }],
      _images_dropped: true,
    })
    const externalized = externalizeResultImages('openai-compat', {
      data: [{ b64_json: Buffer.from('pixel').toString('base64') }],
    })
    const discardedArchive = markResultImagesDropped(externalized.payload)
    expect(extractMeta('openai-compat', discardedArchive).images).toEqual([])
  })
})
