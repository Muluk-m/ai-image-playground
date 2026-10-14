import { describe, expect, it } from 'vitest'
import { clearUrlSettingParams, hasUrlSettingParams } from '../../lib/urlSettings'

describe('url setting params', () => {
  it('recognizes the retired BYOK query keys and leaves unrelated params', () => {
    const params = new URLSearchParams(
      'settings=%7B%7D&apiUrl=https%3A%2F%2Fexample.com&apiKey=sk-test&codexCli=true&apiMode=images&model=gpt-image-2&tab=works',
    )
    expect(hasUrlSettingParams(params)).toBe(true)
    clearUrlSettingParams(params)
    expect(hasUrlSettingParams(params)).toBe(false)
    expect(params.get('tab')).toBe('works')
    expect(params.has('apiKey')).toBe(false)
    expect(params.has('model')).toBe(false)
    expect(params.has('settings')).toBe(false)
  })

  it('does not treat an ordinary page query as a settings link', () => {
    expect(hasUrlSettingParams(new URLSearchParams('tab=works'))).toBe(false)
  })
})
