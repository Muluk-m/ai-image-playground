import { expect, it } from 'vitest'
import { cursorCreatedAt } from '../../hooks/useCloudGenerations'

const objectCursor = btoa(JSON.stringify({ createdAt: 1_700_000_000_000, id: 'generation' }))
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '')
const tupleCursor = btoa(JSON.stringify([1_700_000_000_000, 'generation']))
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '')

it('decodes the generation cursor timestamp from the API tuple', () => {
  expect(cursorCreatedAt(objectCursor)).toBe(1_700_000_000_000)
})

it('also accepts the tuple cursor emitted by the current API', () => {
  expect(cursorCreatedAt(tupleCursor)).toBe(1_700_000_000_000)
})
