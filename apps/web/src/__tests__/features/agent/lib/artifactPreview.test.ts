import type { AgentToolArtifact } from '@image-playground/shared'
import { afterEach, expect, it, vi } from 'vitest'
import {
  artifactPreview,
  fetchedImagePreview,
  INLINE_RESULT_THUMBNAIL_SCALE,
} from '../../../../features/agent/lib/artifactPreview'
import { type AgentCanvasSink, setAgentCanvasSink } from '../../../../features/agent/lib/canvasSink'

afterEach(() => setAgentCanvasSink(null))

it('renders canvas-backed conversation images at enough pixels for a sharp preview', async () => {
  const thumbnail = vi.fn(async () => 'data:image/png;base64,sharp')
  setAgentCanvasSink({ has: () => true, thumbnail } as unknown as AgentCanvasSink)

  const artifact: AgentToolArtifact = {
    artifactId: 'art-1',
    media: 'image',
    taskId: 'task-1',
    outputIndex: 0,
    mime: 'image/png',
  }
  expect((await artifactPreview(artifact, INLINE_RESULT_THUMBNAIL_SCALE)).source).toBe(
    'data:image/png;base64,sharp',
  )
  expect(thumbnail).toHaveBeenCalledWith('art-1', 2.5)

  expect(
    (
      await fetchedImagePreview(
        {
          imageId: '11111111-2222-4333-8444-555555555555',
          sourceUrl: 'https://example.com/image.png',
          mime: 'image/png',
        },
        'fetched-1',
        INLINE_RESULT_THUMBNAIL_SCALE,
      )
    ).source,
  ).toBe('data:image/png;base64,sharp')
  expect(thumbnail).toHaveBeenCalledWith('fetched-1', 2.5)
})
