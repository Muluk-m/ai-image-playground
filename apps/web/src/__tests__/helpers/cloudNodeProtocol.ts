import { canvasSyncAck, canvasSyncStep1, readCanvasSyncMessage } from '@image-playground/shared'
import { vi } from 'vitest'
import * as Y from 'yjs'

/** Records the canvas websocket and completes the sync handshake. */
export class CanvasTestSocket {
  static OPEN = 1
  static instances: CanvasTestSocket[] = []
  readyState = 1
  binaryType = ''
  sent: Uint8Array[] = []
  server = new Y.Doc()
  private repliedVector = false
  onopen?: () => void
  onclose?: (event: { code: number }) => void
  onmessage?: (event: { data: ArrayBuffer }) => void
  constructor() {
    CanvasTestSocket.instances.push(this)
    queueMicrotask(() => this.onopen?.())
  }
  send(data: Uint8Array) {
    const bytes = new Uint8Array(data)
    this.sent.push(bytes)
    try {
      const message = readCanvasSyncMessage(bytes)
      if (message.kind === 'vector' && !this.repliedVector) {
        this.repliedVector = true
        queueMicrotask(() => this.receive(canvasSyncStep1(this.server)))
      } else if (message.kind === 'update') {
        Y.applyUpdate(this.server, message.value)
        queueMicrotask(() => this.receive(canvasSyncAck(this.server)))
      }
    } catch {
      /* leave malformed frames for the assertion that sent them */
    }
  }
  close() {
    this.readyState = 3
    this.onclose?.({ code: 1000 })
  }
  receive(data: Uint8Array) {
    this.onmessage?.({ data: new Uint8Array(data).buffer })
  }
}

export function installCanvasTestSocket() {
  CanvasTestSocket.instances = []
  vi.stubGlobal('WebSocket', CanvasTestSocket)
}

const wrappedDigests = new WeakSet<object>()

/** jsdom responses and Node's SubtleCrypto do not share an ArrayBuffer realm. */
export function tolerateCrossRealmDigest() {
  const subtle = crypto.subtle
  if (wrappedDigests.has(subtle)) return
  wrappedDigests.add(subtle)
  const original = subtle.digest.bind(subtle)
  vi.spyOn(subtle, 'digest').mockImplementation(async (algorithm, data) => {
    const source = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data as ArrayBuffer)
    return original(algorithm, Uint8Array.from(source))
  })
}

export function emptyCanvasUpdate(): ArrayBuffer {
  return new Uint8Array(Y.encodeStateAsUpdate(new Y.Doc())).buffer
}

export function projectIdFromUrl(input: unknown): string {
  const parts = new URL(String(input), 'http://bff.test').pathname.split('/')
  const index = parts.indexOf('projects')
  return index >= 0 ? (parts[index + 1] ?? '') : ''
}

/**
 * Answers the node-canvas HTTP routes. Anything else, including the project JSON
 * document, stays with the caller.
 */
export async function canvasProtocolResponse(
  input: unknown,
  init?: RequestInit,
  canvas: ArrayBuffer | (() => ArrayBuffer | Promise<ArrayBuffer>) = emptyCanvasUpdate(),
): Promise<Response | null> {
  const path = new URL(String(input), 'http://bff.test').pathname
  const method = init?.method ?? 'GET'
  if (path.endsWith('/canvas/commands') && method === 'GET') return Response.json([])
  if (path.endsWith('/canvas') && method === 'GET') {
    const body = typeof canvas === 'function' ? await canvas() : canvas
    return new Response(new Uint8Array(body))
  }
  if (path.endsWith('/canvas/name') && method === 'PUT') return Response.json({ ok: true })
  return null
}
