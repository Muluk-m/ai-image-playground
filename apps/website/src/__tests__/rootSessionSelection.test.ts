import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { ROOT_SESSION_SELECTION_SCRIPT } from '../rootSessionSelection'

function select({ cookie = '', remembered = 'null', search = '', pathname = '/', blockedCookie = false, blockedStorage = false } = {}) {
  const replace = vi.fn()
  const style = { visibility: '' }
  const document = {
    documentElement: { style },
    get cookie() {
      if (blockedCookie) throw new Error('blocked')
      return cookie
    },
  }
  runInNewContext(ROOT_SESSION_SELECTION_SCRIPT, {
    URLSearchParams,
    document,
    localStorage: { getItem: () => {
      if (blockedStorage) throw new Error('blocked')
      return remembered
    } },
    location: { pathname, search, hash: '#draft', replace },
  })
  return { replace, style }
}

describe('root pre-paint selection', () => {
  it.each([
    { cookie: 'image_playground_signed_in=1' },
    { remembered: '"alice"' },
    { search: '?auth_session=1&keep=1' },
    { cookie: 'image_playground_signed_in=1', blockedStorage: true },
    { remembered: '"alice"', blockedCookie: true },
    { search: '?auth_session=1', blockedCookie: true, blockedStorage: true },
  ])('hides marketing synchronously before loading the hinted workspace (%j)', (input) => {
    const { replace, style } = select(input)
    expect(style.visibility).toBe('hidden')
    expect(replace).toHaveBeenCalledExactlyOnceWith(`/workbench${'search' in input ? input.search : ''}#draft`)
  })
  it.each([
    {}, { remembered: 'null' }, { remembered: '{}' }, { remembered: 'broken' },
    { blockedCookie: true, blockedStorage: true },
    { pathname: '/login/', cookie: 'image_playground_signed_in=1' },
    { pathname: '/guide/', cookie: 'image_playground_signed_in=1' },
    { pathname: '/workbench', cookie: 'image_playground_signed_in=1' },
  ])('retains anonymous/document presentation without redirect loops (%j)', (input) => {
    const { replace, style } = select(input)
    expect(style.visibility).toBe('')
    expect(replace).not.toHaveBeenCalled()
  })
})
