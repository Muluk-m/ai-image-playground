import { afterEach, describe, expect, it } from 'vitest'
import {
  clearProjectView,
  currentAgentSurface,
  setProjectView,
} from '../../../../features/canvas/lib/canvasView'

afterEach(() => setProjectView(null))

describe('canvasView', () => {
  it('leaves the next project alone when the old workspace cleans up late', () => {
    setProjectView('old', 'canvas')
    setProjectView('new', 'chat')
    clearProjectView('old', 'canvas')
    expect(currentAgentSurface('new', 'canvas')).toBe('agent')
  })

  it('clears the view it wrote itself', () => {
    setProjectView('p', 'canvas')
    clearProjectView('p', 'canvas')
    expect(currentAgentSurface('p', 'chat')).toBe('agent')
  })

  it("falls back to a project's own default instead of another project's view", () => {
    setProjectView('canvas-project', 'canvas')
    expect(currentAgentSurface('chat-project', 'chat')).toBe('agent')
    setProjectView('chat-project', 'chat')
    expect(currentAgentSurface('canvas-project', 'canvas')).toBe('canvas')
  })
})
