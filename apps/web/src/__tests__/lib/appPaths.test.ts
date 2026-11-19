import { describe, expect, it } from 'vitest'
import { isGuestLoginPromptPath, isProjectPath } from '../../lib/appPaths'

describe('isGuestLoginPromptPath', () => {
  it('includes workbench and creation routes', () => {
    expect(isGuestLoginPromptPath('/image')).toBe(true)
    expect(isGuestLoginPromptPath('/image/')).toBe(true)
    expect(isGuestLoginPromptPath('/explore')).toBe(true)
    expect(isGuestLoginPromptPath('/assets')).toBe(true)
    expect(isGuestLoginPromptPath('/projects')).toBe(true)
    expect(isGuestLoginPromptPath('/tools')).toBe(true)
    expect(isGuestLoginPromptPath('/tools/rotate')).toBe(true)
    expect(isGuestLoginPromptPath('/')).toBe(true)
    expect(isGuestLoginPromptPath('/p/abc')).toBe(true)
  })

  it('excludes standalone, legal, CLI and update routes', () => {
    expect(isGuestLoginPromptPath('/pricing')).toBe(false)
    expect(isGuestLoginPromptPath('/terms')).toBe(false)
    expect(isGuestLoginPromptPath('/privacy')).toBe(false)
    expect(isGuestLoginPromptPath('/device')).toBe(false)
    expect(isGuestLoginPromptPath('/connect')).toBe(false)
    expect(isGuestLoginPromptPath('/changelog')).toBe(false)
    expect(isGuestLoginPromptPath('/unknown')).toBe(false)
  })
})

describe('isProjectPath', () => {
  it('recognizes a single project segment', () => {
    expect(isProjectPath('/p/abc')).toBe(true)
    expect(isProjectPath('/p/abc/extra')).toBe(false)
    expect(isProjectPath('/projects')).toBe(false)
  })
})
