import { describe, expect, it } from 'vitest'
import { shouldUseNodeCanvas } from '../../../../features/canvas/lib/nodeCanvasGate'

const on = { capability: true, cloudProjects: true }

describe('shouldUseNodeCanvas', () => {
  it('stays off until the project record is in the catalog', () => {
    expect(shouldUseNodeCanvas(undefined, on)).toBe(false)
  })

  it('opens a local project when the capability is on', () => {
    expect(shouldUseNodeCanvas({}, on)).toBe(true)
  })

  it('keeps a cloud project on the legacy canvas while sync is unfinished', () => {
    expect(shouldUseNodeCanvas({ cloud: { revision: 1 } }, on)).toBe(false)
  })

  it('treats a cloud record as local when cloud projects are disabled', () => {
    expect(
      shouldUseNodeCanvas({ cloud: { revision: 1 } }, { capability: true, cloudProjects: false }),
    ).toBe(true)
  })

  it('stays off when the capability is off', () => {
    expect(shouldUseNodeCanvas({}, { capability: false, cloudProjects: false })).toBe(false)
    expect(shouldUseNodeCanvas(undefined, { capability: false, cloudProjects: true })).toBe(false)
  })
})
