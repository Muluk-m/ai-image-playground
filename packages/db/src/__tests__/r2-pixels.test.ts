import { describe, expect, it } from 'bun:test'
import {
  MemoryObjectBucket,
  ObjectPixelStore,
  PIXEL_KEY_PREFIX,
  pixelObjectKey,
} from '../r2-pixels'

describe('R2 pixel keys', () => {
  it('nests objects under the playground prefix', () => {
    expect(pixelObjectKey('task-1', 'input', 0)).toBe('image-playground/task-1/input/0')
    expect(pixelObjectKey('task-1', 'output', 2)).toBe('image-playground/task-1/output/2')
    expect(PIXEL_KEY_PREFIX).toBe('image-playground/')
  })

  it('round-trips bytes through an object bucket without exposing a public URL', async () => {
    const store = new ObjectPixelStore(new MemoryObjectBucket())
    await store.putMany('t1', [
      { kind: 'output', idx: 0, mime: 'image/png', data: Buffer.from('out') },
    ])
    const got = await store.get('t1', 'output', 0)
    expect(got?.mime).toBe('image/png')
    expect(got?.data).toEqual(Buffer.from('out'))
    expect(await store.get('t1', 'output', 1)).toBeUndefined()
  })
})
