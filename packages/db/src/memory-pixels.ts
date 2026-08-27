import type { NewPixelObject, PixelKind, PixelObject, PixelStore } from './stores'

function key(taskId: string, kind: PixelKind, idx: number): string {
  return `${taskId}:${kind}:${idx}`
}

export class MemoryPixelStore implements PixelStore {
  private readonly objects = new Map<string, PixelObject>()

  async putMany(taskId: string, pixels: readonly NewPixelObject[]): Promise<void> {
    const now = Date.now()
    for (const pixel of pixels) {
      this.objects.set(key(taskId, pixel.kind, pixel.idx), {
        taskId,
        kind: pixel.kind,
        idx: pixel.idx,
        mime: pixel.mime,
        data: pixel.data,
        createdAt: pixel.createdAt ?? now,
      })
    }
  }

  async get(taskId: string, kind: PixelKind, idx: number): Promise<PixelObject | undefined> {
    return this.objects.get(key(taskId, kind, idx))
  }

  async list(taskId: string, kind: PixelKind): Promise<PixelObject[]> {
    return [...this.objects.values()]
      .filter((pixel) => pixel.taskId === taskId && pixel.kind === kind)
      .sort((a, b) => a.idx - b.idx)
  }

  async replaceBytes(
    taskId: string,
    kind: PixelKind,
    idx: number,
    mime: string,
    data: Buffer,
  ): Promise<void> {
    const current = this.objects.get(key(taskId, kind, idx))
    if (!current) return
    this.objects.set(key(taskId, kind, idx), { ...current, mime, data })
  }

  async deleteOutputsOlderThan(cutoff: number): Promise<number> {
    let removed = 0
    for (const [id, pixel] of this.objects) {
      if (pixel.kind === 'output' && pixel.createdAt < cutoff) {
        this.objects.delete(id)
        removed += 1
      }
    }
    return removed
  }
}
