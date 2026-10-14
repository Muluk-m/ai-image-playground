import {
  CANVAS_STATE_MAX_BYTES,
  canvasSyncAck,
  canvasSyncStep1,
  canvasSyncStep2,
  readCanvasSyncMessage,
} from '@image-playground/shared'
import { and, eq, isNull } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import * as Y from 'yjs'
import { config } from '../config'
import { db, schema } from '../db/client'
import { listCanvasCommands, reverseStoredCanvasCommand } from '../lib/canvasCommands'
import { type CanvasPeer, canvasSyncRooms } from '../lib/canvasSyncRooms'
import { accessCanvasDocument, CanvasSyncError } from '../lib/canvasSyncStore'
import { isCapabilityEnabled } from '../lib/capabilities'
import { resolveAuthUser } from '../lib/user-auth'
import { resolveUserSession, USER_SESSION_COOKIE } from '../lib/user-session'

const id = t.Object({ id: t.String({ format: 'uuid' }) })
const sessions = new Map<
  string,
  {
    peer: CanvasPeer
    queue: Promise<void>
    closed: boolean
    frames: number
    window: number
    pendingBytes: number
    pendingFrames: number
  }
>()
export const canvasSyncRoutes = new Elysia({ name: 'canvas-sync' })
  .use(resolveAuthUser)
  .onBeforeHandle(({ authUser, status }) => {
    if (!authUser) return status(401, { error: 'unauthorized' })
    if (!isCapabilityEnabled('accounts:sync') || !isCapabilityEnabled('canvas:nodes'))
      return status(403, { error: 'canvas_sync_unavailable' })
  })
  .get(
    '/api/projects/:id/canvas',
    async ({ authUser, params, status }) => {
      try {
        const update = await accessCanvasDocument(authUser!.id, params.id)
        return new Response(new Uint8Array(update).buffer, {
          headers: {
            'content-type': 'application/octet-stream',
            'cache-control': 'private, no-store',
          },
        })
      } catch (error) {
        if (error instanceof CanvasSyncError) return status(error.status, { error: error.message })
        throw error
      }
    },
    { params: id },
  )
  .get(
    '/api/projects/:id/canvas/commands',
    async ({ authUser, params, status }) => {
      try {
        return await listCanvasCommands(authUser!.id, params.id)
      } catch (error) {
        if (error instanceof CanvasSyncError) return status(error.status, { error: error.message })
        throw error
      }
    },
    { params: id },
  )
  .post(
    '/api/projects/:id/canvas/commands/:commandId/reverse',
    async ({ authUser, params, body, status }) => {
      try {
        const update = await reverseStoredCanvasCommand(
          authUser!.id,
          params.id,
          params.commandId,
          body.revision,
        )
        return new Response(new Uint8Array(update).buffer, {
          headers: {
            'content-type': 'application/octet-stream',
            'cache-control': 'private, no-store',
          },
        })
      } catch (error) {
        if (error instanceof CanvasSyncError) return status(error.status, { error: error.message })
        throw error
      }
    },
    {
      params: t.Object({
        id: t.String({ format: 'uuid' }),
        commandId: t.String({ format: 'uuid' }),
      }),
      body: t.Object({ revision: t.Integer({ minimum: 0 }) }),
    },
  )
  .put(
    '/api/projects/:id/canvas/name',
    async ({ authUser, params, body, status }) => {
      // Reuses ownership/deletion checks; only metadata changes, never an old document overwrite.
      try {
        await accessCanvasDocument(authUser!.id, params.id)
      } catch (error) {
        if (error instanceof CanvasSyncError) return status(error.status, { error: error.message })
        throw error
      }
      const renamed = await db
        .update(schema.canvas_projects)
        .set({ name: body.name.trim(), updated_at: Date.now() })
        .where(
          and(
            eq(schema.canvas_projects.id, params.id),
            eq(schema.canvas_projects.user_id, authUser!.id),
            isNull(schema.canvas_projects.deleted_at),
          ),
        )
        .returning({ id: schema.canvas_projects.id })
      if (!renamed.length) return status(410, { error: 'project_deleted' })
      return { ok: true }
    },
    {
      params: id,
      body: t.Object({ name: t.String({ minLength: 1, maxLength: 120, pattern: '\\S' }) }),
    },
  )
  .ws('/api/projects/:id/canvas/ws', {
    params: id,
    maxPayloadLength: CANVAS_STATE_MAX_BYTES + 64,
    idleTimeout: 60,
    beforeHandle: async ({ request, authUser, params, status }) => {
      // Cookie-authenticated WS needs an explicit Origin check; CORS does not protect upgrades.
      const origin = request.headers.get('origin')
      if (
        !origin ||
        (origin !== new URL(request.url).origin && !config.corsOriginList.includes(origin))
      )
        throw status(403, { error: 'invalid_origin' })
      if (!authUser) throw status(401, { error: 'unauthorized' })
      if (!isCapabilityEnabled('accounts:sync') || !isCapabilityEnabled('canvas:nodes'))
        throw status(403, { error: 'canvas_sync_unavailable' })
      try {
        await accessCanvasDocument(authUser.id, params.id)
      } catch (error) {
        if (error instanceof CanvasSyncError) throw status(error.status, { error: error.message })
        throw error
      }
    },
    open(ws) {
      const peer: CanvasPeer = {
        authorize: async () => {
          const token = ws.data.cookie[USER_SESSION_COOKIE]?.value
          const user = await resolveUserSession(typeof token === 'string' ? token : '')
          return (
            !!user &&
            user.id === ws.data.authUser!.id &&
            isCapabilityEnabled('canvas:nodes') &&
            isCapabilityEnabled('accounts:sync')
          )
        },
        send: (bytes) => {
          if (ws.raw.readyState === 1) ws.raw.sendBinary(bytes)
        },
        close: (code, reason) => {
          ws.close(code, reason)
        },
        terminate: () => ws.terminate(),
      }
      const session = {
        peer,
        queue: Promise.resolve(),
        closed: false,
        frames: 0,
        pendingBytes: 0,
        pendingFrames: 0,
        window: Date.now(),
      }
      sessions.set(ws.id, session)
      session.queue = (async () => {
        await canvasSyncRooms.join(ws.data.params.id, ws.data.authUser!.id, peer)
        if (session.closed) {
          canvasSyncRooms.leave(ws.data.params.id, peer)
          return
        }
        const doc = new Y.Doc()
        try {
          Y.applyUpdate(doc, await accessCanvasDocument(ws.data.authUser!.id, ws.data.params.id))
          peer.send(canvasSyncStep1(doc))
        } finally {
          doc.destroy()
        }
      })().catch(() => peer.close(1011, 'canvas_sync_failed'))
      return session.queue
    },
    message(ws, raw) {
      const session = sessions.get(ws.id)
      if (!session || session.closed) return
      if (Date.now() - session.window >= 1000) {
        session.frames = 0
        session.window = Date.now()
      }
      if (++session.frames > 120 || !(raw instanceof Uint8Array || raw instanceof ArrayBuffer)) {
        ws.close(1008, 'invalid_canvas_message')
        return
      }
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
      // Bound retained frames while a transaction waits on the user row lock.
      if (
        session.pendingFrames >= 32 ||
        session.pendingBytes + bytes.byteLength > CANVAS_STATE_MAX_BYTES * 2
      ) {
        session.closed = true
        ws.close(1013, 'canvas_backpressure')
        return
      }
      session.pendingFrames++
      session.pendingBytes += bytes.byteLength
      session.queue = session.queue
        .then(async () => {
          if (session.closed) return
          if (!(await session.peer.authorize())) {
            ws.close(1008, 'unauthorized')
            return
          }
          const message = readCanvasSyncMessage(bytes)
          if (message.kind === 'ack') throw new Error('invalid_canvas_message')
          const state = await accessCanvasDocument(
            ws.data.authUser!.id,
            ws.data.params.id,
            message.kind === 'update' ? message.value : undefined,
          )
          const doc = new Y.Doc()
          try {
            Y.applyUpdate(doc, state)
            if (message.kind === 'vector') session.peer.send(canvasSyncStep2(doc, message.value))
            else {
              session.peer.send(canvasSyncAck(doc))
              await canvasSyncRooms.refresh(ws.data.params.id)
            }
          } finally {
            doc.destroy()
          }
        })
        .catch((error) =>
          ws.close(
            error instanceof CanvasSyncError && error.status === 410 ? 4004 : 1008,
            error instanceof CanvasSyncError ? error.message : 'invalid_canvas_message',
          ),
        )
      session.queue = session.queue.finally(() => {
        session.pendingFrames--
        session.pendingBytes -= bytes.byteLength
      })
      return session.queue
    },
    close(ws) {
      const session = sessions.get(ws.id)
      if (!session) return
      session.closed = true
      sessions.delete(ws.id)
      canvasSyncRooms.leave(ws.data.params.id, session.peer)
    },
  })
  .onStop(() => canvasSyncRooms.close())
