import { beginImport, exportStorage, importEntry, type StorageSource } from './storage'

export interface CompatibilityConfig {
  sourceOrigin: string
  targetOrigin: string
}
const PROTOCOL = 'muvloom-local-storage-v1'
const DONE = 'muvloom-local-compatibility-v3'
const IDLE_MS = 15_000

type StorageDocument = Document & {
  hasStorageAccess?: () => Promise<boolean>
  requestStorageAccess?: (options: {
    indexedDB: true
    localStorage: true
  }) => Promise<StorageSource>
}

/** Never ask for a permission prompt during startup, or read a partitioned empty database. */
export async function originalStorage(doc: StorageDocument): Promise<StorageSource | null> {
  if (!doc.hasStorageAccess || !doc.requestStorageAccess) return null
  if (!(await doc.hasStorageAccess())) return null
  const handle = await doc.requestStorageAccess({ indexedDB: true, localStorage: true })
  return handle?.indexedDB && handle?.localStorage ? handle : null
}

/** Each acknowledgement means the destination transaction has committed. */
export async function serveStorage(port: MessagePort, source: StorageSource): Promise<void> {
  port.start()
  try {
    for await (const entry of exportStorage(source)) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Local receiver unavailable')), IDLE_MS)
        port.onmessage = (event) => {
          clearTimeout(timer)
          if (event.data === 'ack') resolve()
          else reject(new Error('Local import failed'))
        }
        port.postMessage({ entry })
      })
    }
    port.postMessage({ done: true })
  } catch (error) {
    port.postMessage({ unavailable: true })
    throw error
  } finally {
    port.close()
  }
}

export function installSourceBridge(config: CompatibilityConfig): void {
  if (location.origin !== config.sourceOrigin || window.parent === window) return
  let connected = false
  window.addEventListener('message', async (event) => {
    if (
      connected ||
      event.origin !== config.targetOrigin ||
      event.source !== parent ||
      event.data !== PROTOCOL ||
      event.ports.length !== 1
    )
      return
    connected = true
    const port = event.ports[0]!
    try {
      const source = await originalStorage(document as StorageDocument)
      if (!source) throw new Error('Original storage unavailable')
      await serveStorage(port, source)
    } catch {
      port.postMessage({ unavailable: true })
      port.close()
    }
  })
  parent.postMessage(PROTOCOL, config.targetOrigin)
}

/** Runs before store imports. Failure leaves the original workbench available. */
export async function restoreLocalStorage(config: CompatibilityConfig): Promise<boolean> {
  if (location.origin !== config.targetOrigin) return true
  try {
    if (localStorage.getItem(DONE) === config.sourceOrigin) return true
  } catch {
    return false
  }
  beginImport()
  let resolved = true
  const frame = document.createElement('iframe')
  frame.hidden = true
  frame.src = `${config.sourceOrigin}/local-compat.html`
  const channel = new MessageChannel()
  let timer: ReturnType<typeof setTimeout>
  let stopped = false
  return new Promise<boolean>((resolve) => {
    const finish = (success: boolean) => {
      if (stopped) return
      stopped = true
      clearTimeout(timer)
      window.removeEventListener('message', ready)
      channel.port1.close()
      frame.remove()
      resolve(success)
    }
    const resetTimeout = () => {
      clearTimeout(timer)
      timer = setTimeout(() => finish(false), IDLE_MS)
    }
    const ready = (event: MessageEvent) => {
      if (
        event.origin !== config.sourceOrigin ||
        event.source !== frame.contentWindow ||
        event.data !== PROTOCOL
      )
        return
      window.removeEventListener('message', ready)
      frame.contentWindow!.postMessage(PROTOCOL, config.sourceOrigin, [channel.port2])
    }
    channel.port1.onmessage = async (event) => {
      if (stopped) return
      resetTimeout()
      try {
        if (event.data?.done) {
          if (resolved) localStorage.setItem(DONE, config.sourceOrigin)
          finish(resolved)
        } else if (event.data?.entry) {
          if (!(await importEntry(event.data.entry))) resolved = false
          if (!stopped) {
            channel.port1.postMessage('ack')
            resetTimeout()
          }
        } else finish(false)
      } catch {
        finish(false)
      }
    }
    window.addEventListener('message', ready)
    resetTimeout()
    document.body.append(frame)
  })
}
