import { describe, expect, it } from 'vitest'
import { shouldUseNodeCanvas } from '../../../../features/canvas/lib/nodeCanvasGate'

describe('shouldUseNodeCanvas', () => {
  it('stays off until the project record is in the catalog', () => {
    expect(shouldUseNodeCanvas(undefined)).toBe(false)
  })

  it('opens a local project', () => {
    expect(shouldUseNodeCanvas({})).toBe(true)
  })

  it('opens a cloud project', () => {
    expect(shouldUseNodeCanvas({ cloud: { revision: 1 } })).toBe(true)
  })
})
