// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { exportMarkedImage } from '../../../../features/agent/lib/artifactEdit'

it('refuses a stale or uninitialized mask before exporting a mismatched image/mask pair', () => {
  const mask = document.createElement('canvas')
  mask.width = 1024
  mask.height = 1024
  const getContext = vi.spyOn(mask, 'getContext')
  const image = document.createElement('img')
  Object.defineProperties(image, { naturalWidth: { value: 1536 }, naturalHeight: { value: 1024 } })
  expect(() => exportMarkedImage('data:image/png;base64,original', mask, image)).toThrow('尺寸')
  expect(getContext).not.toHaveBeenCalled()
})
