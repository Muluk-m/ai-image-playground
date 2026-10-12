import { canvasSyncUpdate } from '@image-playground/shared'
import postgres from 'postgres'
import * as Y from 'yjs'
import { config } from '../config'
import { accessCanvasDocument } from './canvasSyncStore'

export interface CanvasPeer {
  send(bytes: Uint8Array): void
  close(code: number, reason: string): void
  terminate?(): void
}
interface Room {
  userId: string
  doc: Y.Doc
  peers: Set<CanvasPeer>
  queue: Promise<void>
}
/** One notification connection per process, not per project or socket. Pool queries remain on the BFF pool. */
export class CanvasSyncRooms {
  private rooms = new Map<string, Room>()
  private listener: ReturnType<typeof postgres> | undefined
  private listening: Promise<unknown> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private ensureListening() {
    if (this.listening) return this.listening
    this.listener = postgres(process.env.DATABASE_URL?.trim() || config.databaseUrl, {
      max: 1,
      connection: { application_name: 'bff-canvas-listener' },
    })
    const listener = this.listener
    this.listening = listener
      .listen(
        'canvas_changed',
        (id) => {
          void this.refresh(id)
        },
        () => {
          for (const id of this.rooms.keys()) void this.refresh(id)
        },
      )
      .catch(async (error) => {
        this.listening = undefined
        await listener.end({ timeout: 1 })
        throw error
      })
    // Catch revoked sessions/deleted projects and notification gaps even with an idle canvas.
    this.timer ??= setInterval(() => {
      for (const id of this.rooms.keys()) void this.refresh(id)
    }, 15_000)
    this.timer.unref()
    return this.listening
  }
  async join(id: string, userId: string, peer: CanvasPeer) {
    await this.ensureListening()
    let room = this.rooms.get(id)
    if (!room) {
      room = { userId, doc: new Y.Doc(), peers: new Set(), queue: Promise.resolve() }
      this.rooms.set(id, room)
    }
    room.peers.add(peer)
    await this.refresh(id)
  }
  leave(id: string, peer: CanvasPeer) {
    const room = this.rooms.get(id)
    room?.peers.delete(peer)
    if (room && !room.peers.size) {
      this.rooms.delete(id)
      room.doc.destroy()
    }
  }
  refresh(id: string): Promise<void> {
    const room = this.rooms.get(id)
    if (!room) return Promise.resolve()
    room.queue = room.queue
      .then(async () => {
        if (this.rooms.get(id) !== room) return
        const state = await accessCanvasDocument(room.userId, id)
        if (this.rooms.get(id) !== room) return
        const vector = Y.encodeStateVector(room.doc)
        let changed = false
        const observe = () => {
          changed = true
        }
        room.doc.on('update', observe)
        Y.applyUpdate(room.doc, state)
        room.doc.off('update', observe)
        if (changed)
          for (const peer of room.peers)
            peer.send(canvasSyncUpdate(Y.encodeStateAsUpdate(room.doc, vector)))
      })
      .catch(() => {
        for (const peer of room.peers) peer.close(1012, 'canvas_reload_required')
      })
    return room.queue
  }
  async close() {
    clearInterval(this.timer)
    const peers = [...this.rooms.values()].flatMap((room) => [...room.peers])
    const pending = [...this.rooms.values()].map((room) => room.queue)
    for (const room of this.rooms.values()) {
      for (const peer of room.peers) peer.close(1012, 'server_restarting')
      room.doc.destroy()
    }
    this.rooms.clear()
    if (peers.length) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      for (const peer of peers) peer.terminate?.()
    }
    await Promise.allSettled(pending)
    await this.listener?.end({ timeout: 1 })
    this.listener = undefined
    this.listening = undefined
  }
}
export const canvasSyncRooms = new CanvasSyncRooms()
