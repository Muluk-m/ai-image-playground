import type { AgentToolArtifact } from '@image-playground/shared'
import { unzipSync } from 'fflate'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type BatchResultFile,
  type BatchResultSource,
  batchResultFiles,
  exportBatchResults,
} from '../../../../features/agent/lib/batchResultExport'

const downloaded: Array<{ blob: Blob; filename: string }> = []

vi.mock('../../../../lib/downloadImages', () => ({
  downloadBlob: (blob: Blob, filename: string) => downloaded.push({ blob, filename }),
}))

function artifact(id: string, media: 'image' | 'video' = 'image'): AgentToolArtifact {
  return { artifactId: id, media, taskId: `task-${id}`, outputIndex: 0, mime: 'image/png' }
}

function item(
  label: string,
  status: string,
  artifacts: AgentToolArtifact[] = [],
): BatchResultSource {
  return {
    label,
    progress: status,
    execution: { status: status === 'in_flight' ? 'in_progress' : status, artifacts },
  }
}

beforeEach(() => {
  downloaded.length = 0
})

describe('batchResultFiles', () => {
  it('lists only the current completed results, in plan order', () => {
    const files = batchResultFiles([
      item('01-主图场景.png', 'ready', [artifact('skipped-ready')]),
      item('02-场景二-烛光深色墙', 'completed', [artifact('wall'), artifact('wall-2')]),
      item('03-场景三', 'failed', [artifact('skipped-failed')]),
      item('u1-style-only-3-4view', 'in_flight'),
      item('', 'completed', [artifact('bare')]),
      item('a/b:c*?.png', 'completed', [artifact('unsafe')]),
    ])
    expect(files.map((file) => [file.stem, file.artifact.artifactId])).toEqual([
      ['02-02-场景二-烛光深色墙-1', 'wall'],
      ['02-02-场景二-烛光深色墙-2', 'wall-2'],
      ['05-image', 'bare'],
      ['06-a b c', 'unsafe'],
    ])
  })
})

describe('exportBatchResults', () => {
  const files: BatchResultFile[] = [
    { artifact: artifact('one'), stem: '01-主图' },
    { artifact: artifact('two', 'video'), stem: '02-夜景' },
    { artifact: artifact('gone'), stem: '03-缺失' },
  ]

  it('zips the files it could fetch and counts the rest as failed', async () => {
    const progress: Array<[number, number]> = []
    const result = await exportBatchResults(files, {
      baseName: '48张图片背景优化计划/保留',
      onProgress: (done, total) => progress.push([done, total]),
      fetchArtifact: async (one) => {
        if (one.artifactId === 'gone') return null
        if (one.media === 'video') return new Blob(['video'], { type: 'application/octet-stream' })
        return new Blob(['png'], { type: 'image/png' })
      },
    })
    expect(result).toEqual({ exported: 2, failed: 1 })
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ])
    expect(downloaded).toHaveLength(1)
    expect(downloaded[0]!.filename).toBe('48张图片背景优化计划 保留.zip')
    const entries = unzipSync(new Uint8Array(await downloaded[0]!.blob.arrayBuffer()))
    expect(Object.keys(entries).sort()).toEqual(['01-主图.png', '02-夜景.mp4'])
  })

  it('downloads a single image directly', async () => {
    const result = await exportBatchResults([files[0]!], {
      baseName: '计划',
      fetchArtifact: async () => new Blob(['png'], { type: 'image/jpeg' }),
    })
    expect(result).toEqual({ exported: 1, failed: 0 })
    expect(downloaded.map((file) => file.filename)).toEqual(['01-主图.jpg'])
  })

  it('does not download when every result is missing', async () => {
    const result = await exportBatchResults([files[2]!], {
      baseName: '计划',
      fetchArtifact: async () => null,
    })
    expect(result).toEqual({ exported: 0, failed: 1 })
    expect(downloaded).toHaveLength(0)
  })
})
