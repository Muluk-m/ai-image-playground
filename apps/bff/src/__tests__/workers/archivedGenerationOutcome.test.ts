import { describe, expect, it } from 'bun:test'
import { archivedGenerationOutcome } from '../../workers/archivedGenerationOutcome'

const output = { role: 'output' as const, position: 0, mediaId: 'media-1' }

describe('archived generation outcome', () => {
  it('keeps a candidate with no output links completed', () => {
    expect(archivedGenerationOutcome({ candidate: true, missing: false, media: [] })).toEqual({
      status: 'completed',
    })
  })

  it('fails a non-candidate that archived no output links', () => {
    expect(
      archivedGenerationOutcome({
        candidate: false,
        missing: false,
        media: [{ role: 'input', position: 0, mediaId: 'in' }],
      }),
    ).toEqual({ status: 'failed', errorType: 'upstream_no_image' })
  })

  it('keeps a normal archive with an output link completed', () => {
    expect(
      archivedGenerationOutcome({ candidate: false, missing: false, media: [output] }),
    ).toEqual({ status: 'completed' })
  })

  it('does not treat a legacy result without media links as empty', () => {
    expect(
      archivedGenerationOutcome({ candidate: false, missing: false, media: undefined }),
    ).toEqual({ status: 'completed' })
  })

  it('keeps an interrupted archive on the recoverable error', () => {
    expect(archivedGenerationOutcome({ candidate: false, missing: true, media: [] })).toEqual({
      status: 'failed',
      errorType: 'upstream_result_unknown',
    })
  })
})
