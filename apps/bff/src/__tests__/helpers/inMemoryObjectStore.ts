import type { ObjectStore } from '../../lib/objectStore'

export class InMemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { bytes: Uint8Array<ArrayBuffer>; contentType: string }>()
  readonly events: string[] = []
  writeFailuresRemaining = 0
  readFailuresRemaining = 0
  deleteFailuresRemaining = 0
  beforeDeletePrefix?: (prefix: string) => void | Promise<void>

  async write(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.events.push(`write:${key}`)
    if (this.writeFailuresRemaining > 0) {
      this.writeFailuresRemaining--
      throw new Error('in-memory write failure')
    }
    this.objects.set(key, { bytes: Uint8Array.from(bytes), contentType })
  }

  async read(key: string): Promise<Uint8Array<ArrayBuffer>> {
    this.events.push(`read:${key}`)
    if (this.readFailuresRemaining > 0) {
      this.readFailuresRemaining--
      throw new Error('in-memory read failure')
    }
    const stored = this.objects.get(key)
    if (!stored) throw new Error(`missing object: ${key}`)
    return stored.bytes.slice()
  }

  async listPrefix(prefix: string): Promise<string[]> {
    this.events.push(`list:${prefix}`)
    return Array.from(this.objects.keys()).filter((key) => key.startsWith(prefix))
  }

  async deletePrefix(prefix: string): Promise<void> {
    this.events.push(`delete:${prefix}`)
    await this.beforeDeletePrefix?.(prefix)
    if (this.deleteFailuresRemaining > 0) {
      this.deleteFailuresRemaining--
      throw new Error('in-memory delete failure')
    }
    for (const key of this.objects.keys()) {
      if (key.startsWith(prefix)) this.objects.delete(key)
    }
  }
}
