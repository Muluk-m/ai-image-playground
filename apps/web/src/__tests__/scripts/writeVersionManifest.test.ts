import { describe, expect, it } from 'vitest'

import { buildVersionManifest } from '../../../scripts/write-version-manifest.mjs'

const REPO_ROOT = new URL('../../../../..', import.meta.url).pathname
const AT = new Date('2026-09-01T07:29:21.000Z')

describe('buildVersionManifest', () => {
  it('defaults to a silent release', () => {
    expect(buildVersionManifest({}, REPO_ROOT, AT).notify).toBe(false)
    expect(buildVersionManifest({ NOTIFY_UPDATE: '' }, REPO_ROOT, AT).notify).toBe(false)
    expect(buildVersionManifest({ NOTIFY_UPDATE: 'false' }, REPO_ROOT, AT).notify).toBe(false)
  })

  it('marks the release as worth interrupting for when asked', () => {
    expect(buildVersionManifest({ NOTIFY_UPDATE: 'true' }, REPO_ROOT, AT).notify).toBe(true)
  })

  it('rejects a NOTIFY_UPDATE that is neither true nor false', () => {
    expect(() => buildVersionManifest({ NOTIFY_UPDATE: '1' }, REPO_ROOT, AT)).toThrow(
      /NOTIFY_UPDATE must be true or false/,
    )
  })

  // 带 private overlay 的检出会多出 `+<sha>` 段，构建期两种形态都要认。
  it('stamps the build time and the commits it was built from', () => {
    expect(buildVersionManifest({}, REPO_ROOT, AT).version).toMatch(
      /^[0-9a-f]{7,}(\+[0-9a-f]{7,})?-20260901T072921Z$/,
    )
  })

  it('falls back to the timestamp alone outside a checkout', () => {
    expect(buildVersionManifest({}, '/', AT).version).toBe('20260901T072921Z')
  })
})
