import { VIDEO_MODEL_SUPPORT } from '@image-playground/shared'
import { expect, it } from 'vitest'
import type { NodeReference } from '../../../../features/canvas/lib/nodeCanvasFlow'
import {
  effectiveNodeVideoMode,
  nodeVideoInputs,
  nodeVideoModes,
  nodeVideoSupport,
} from '../../../../features/canvas/lib/nodeVideoModes'

const refs: NodeReference[] = [
  { id: 'text', kind: 'text', label: 'script', text: 'a story' },
  { id: 'asset', kind: 'image', label: 'asset', fileId: 'asset', asset: true },
  { id: 'one', kind: 'image', label: 'one', fileId: 'one' },
  { id: 'two', kind: 'image', label: 'two', fileId: 'two' },
]
it('only offers generation modes declared by the model and channel', () => {
  for (const support of Object.values(VIDEO_MODEL_SUPPORT)) {
    const modes = nodeVideoModes(support)
    expect(modes.includes('first')).toBe(support.firstFrame)
    expect(modes.includes('frames')).toBe(support.firstFrame && support.lastFrame)
    expect(modes.includes('reference')).toBe(Boolean(support.referenceImages))
    expect(effectiveNodeVideoMode(support)).toBe(
      support.referenceImages ? 'reference' : support.firstFrame ? 'first' : 'text',
    )
    expect(effectiveNodeVideoMode(support, 'text')).toBe('text')
  }
})
it('resolves four input modes without leaking unused images into the request', () => {
  expect(nodeVideoInputs('text', refs).refs.map((ref) => ref.id)).toEqual(['text'])
  expect(nodeVideoInputs('first', refs).roles).toEqual({ one: 'first' })
  expect(nodeVideoInputs('frames', refs).roles).toEqual({ one: 'first', two: 'last' })
  expect(nodeVideoInputs('reference', refs).roles).toEqual({
    asset: 'reference',
    one: 'reference',
    two: 'reference',
  })
})
it('swaps explicit slots, refuses asset frames and never substitutes a missing explicit frame', () => {
  expect(nodeVideoInputs('frames', refs, { first: 'two', last: 'one' }).roles).toEqual({
    two: 'first',
    one: 'last',
  })
  expect(nodeVideoInputs('first', refs, { first: 'asset' }).missing).toBe(true)
  expect(nodeVideoInputs('first', refs, { first: 'deleted' }).missing).toBe(true)
  expect(nodeVideoInputs('frames', refs, { first: 'one', last: 'one' }).missing).toBe(true)
})

it('constrains quality for references, tail frames and voices before submission', () => {
  const support = VIDEO_MODEL_SUPPORT['grok-imagine-video']!
  expect(nodeVideoSupport(support, 'text').resolutions).toContain('1080p')
  expect(nodeVideoSupport(support, 'first').resolutions).toContain('1080p')
  expect(nodeVideoSupport(support, 'reference').resolutions).toEqual(['720p'])
  expect(nodeVideoSupport(support, 'frames').resolutions).toEqual(['720p'])
  expect(nodeVideoSupport(support, 'text', true).resolutions).toEqual(['720p'])
})
