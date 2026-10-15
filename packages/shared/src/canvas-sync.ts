import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as sync from 'y-protocols/sync'
import * as Y from 'yjs'

export const CANVAS_STATE_MAX_BYTES = 4 * 1024 * 1024
/** Outer frame 0 is the standard y-websocket/y-protocols sync envelope. */
export function canvasSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0)
  sync.writeSyncStep1(encoder, doc)
  return encoding.toUint8Array(encoder)
}
export function canvasSyncStep2(doc: Y.Doc, vector: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0)
  sync.writeSyncStep2(encoder, doc, vector)
  return encoding.toUint8Array(encoder)
}
export function canvasSyncUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 0)
  sync.writeUpdate(encoder, update)
  return encoding.toUint8Array(encoder)
}
/** Acknowledgement is sent only after PostgreSQL commits, never on socket.send(). */
export function canvasSyncAck(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, 2)
  encoding.writeVarUint8Array(encoder, Y.encodeStateVector(doc))
  return encoding.toUint8Array(encoder)
}
export function readCanvasSyncMessage(bytes: Uint8Array): {
  kind: 'vector' | 'update' | 'ack'
  value: Uint8Array
} {
  if (bytes.length > CANVAS_STATE_MAX_BYTES + 64) throw new Error('canvas_message_too_large')
  const decoder = decoding.createDecoder(bytes)
  const outer = decoding.readVarUint(decoder)
  const type = outer === 0 ? decoding.readVarUint(decoder) : -1
  const kind =
    outer === 2 ? 'ack' : type === 0 ? 'vector' : type === 1 || type === 2 ? 'update' : null
  if (!kind) throw new Error('invalid_canvas_message')
  const value = decoding.readVarUint8Array(decoder)
  if (decoding.hasContent(decoder)) throw new Error('invalid_canvas_message')
  return { kind, value }
}
