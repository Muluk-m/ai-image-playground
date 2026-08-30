import { describe, expect, it } from 'bun:test'
import { gzipBlob } from '../../lib/staticCompression'

describe('gzipBlob', () => {
  it('round-trips static asset bytes on the supported Bun runtime', async () => {
    const source = new TextEncoder().encode('export const ready = true;'.repeat(100))
    const compressed = await gzipBlob(new Blob([source]))
    const restored = Bun.gunzipSync(compressed)

    expect(compressed.byteLength).toBeLessThan(source.length)
    expect(restored).toEqual(source)
  })
})
