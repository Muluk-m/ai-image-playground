import { unzipSync } from 'fflate'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaBundleEntry } from '../../../../features/canvas/lib/exportImages'
import { transferMedia, useMediaTransferStore } from '../../../../features/canvas/lib/mediaTransfer'
import { useStore } from '../../../../store'

const downloaded: Array<{ blob: Blob; filename: string }> = []

vi.mock('../../../../lib/downloadImages', () => ({
  downloadBlob: (blob: Blob, filename: string) => downloaded.push({ blob, filename }),
}))

function entry(name: string, body: string | null): MediaBundleEntry {
  return {
    name,
    fetch: async () => (body === null ? null : { blob: new Blob([body]), ext: 'png' }),
  }
}

describe('transferMedia', () => {
  beforeEach(() => {
    downloaded.length = 0
    useMediaTransferStore.setState({ transfer: null })
  })

  it('downloads one item directly without a transfer card', async () => {
    const result = await transferMedia([entry('猫', 'a')], '我的项目')
    expect(result).toEqual({ exported: 1, failed: 0 })
    expect(downloaded.map((one) => one.filename)).toEqual(['猫.png'])
    expect(useMediaTransferStore.getState().transfer).toBeNull()
  })

  it('zips several items as <project>_<n>项 and finishes the transfer card', async () => {
    const result = await transferMedia([entry('猫', 'a'), entry('猫', 'b')], '我的项目')
    expect(result).toEqual({ exported: 2, failed: 0 })
    expect(downloaded.map((one) => one.filename)).toEqual(['我的项目_2项.zip'])
    const zip = unzipSync(new Uint8Array(await downloaded[0]!.blob.arrayBuffer()))
    expect(Object.keys(zip)).toEqual(['01-猫.png', '02-猫.png'])
    expect(useMediaTransferStore.getState().transfer).toMatchObject({
      fileName: '我的项目_2项.zip',
      status: 'finished',
      progress: 1,
    })
  })

  it('marks the transfer failed and warns when nothing could be fetched', async () => {
    const showToast = vi.spyOn(useStore.getState(), 'showToast')
    const result = await transferMedia([entry('a', null), entry('b', null)], '')
    expect(result).toEqual({ exported: 0, failed: 2 })
    expect(downloaded).toEqual([])
    expect(useMediaTransferStore.getState().transfer?.status).toBe('failed')
    expect(useMediaTransferStore.getState().transfer?.fileName).toBe('Muvloom_2项.zip')
    expect(showToast).toHaveBeenCalledWith(expect.any(String), 'error')
  })
})
