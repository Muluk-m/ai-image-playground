import { createHash } from 'node:crypto'
import type { CanvasOrigin } from '@image-playground/shared'
import { and, desc, eq, inArray, ne } from 'drizzle-orm'
import * as Y from 'yjs'
import { schema } from '../db/client'
import { prepareCanvasCommand, reverseCanvasCommand } from './canvasCommandHistory'
import { accessCanvasDocument, CanvasSyncError } from './canvasSyncStore'

const commands = schema.canvas_commands
const encode = (bytes: Uint8Array) =>
  Buffer.from(Bun.gzipSync(new Uint8Array(bytes))).toString('base64')
const decode = (value: string) => Bun.gunzipSync(Buffer.from(value, 'base64'))
const summaryFields = {
  id: commands.id,
  label: commands.label,
  revision: commands.revision,
  reversed: commands.reversed,
  createdAt: commands.created_at,
  updatedAt: commands.updated_at,
}

/** Both the history record and its validated graph update commit under the project owner lock. */
export async function executeCanvasCommand(
  userId: string,
  projectId: string,
  call: { turnId: string; toolCallId: string; label: string; args: unknown },
  mutate: (doc: Y.Doc, origin: CanvasOrigin) => void,
) {
  const fingerprint = createHash('sha256').update(JSON.stringify(call.args)).digest('hex')
  let commandId = ''
  await accessCanvasDocument(userId, projectId, async (doc, tx) => {
    const [existing] = await tx
      .select()
      .from(commands)
      .where(
        and(
          eq(commands.project_id, projectId),
          eq(commands.turn_id, call.turnId),
          eq(commands.tool_call_id, call.toolCallId),
        ),
      )
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new CanvasSyncError(409, 'canvas_command_conflict')
      commandId = existing.id
      return undefined
    }
    const record = prepareCanvasCommand(Y.encodeStateAsUpdate(doc), mutate)
    const now = Date.now()
    commandId = crypto.randomUUID()
    await tx.insert(commands).values({
      id: commandId,
      project_id: projectId,
      turn_id: call.turnId,
      tool_call_id: call.toolCallId,
      fingerprint,
      label: call.label,
      before: encode(record.before),
      update: encode(record.update),
      created_at: now,
      updated_at: now,
    })
    // Keep idempotency receipts, but bound retained undo snapshots to the visible history window.
    const expired = await tx
      .select({ id: commands.id })
      .from(commands)
      .where(and(eq(commands.project_id, projectId), ne(commands.before, '')))
      .orderBy(desc(commands.created_at), desc(commands.id))
      .offset(64)
    if (expired.length)
      await tx
        .update(commands)
        .set({ before: '', update: '' })
        .where(
          inArray(
            commands.id,
            expired.map((item) => item.id),
          ),
        )
    return record.update
  })
  return { commandId }
}

export async function listCanvasCommands(userId: string, projectId: string) {
  let history: Array<{
    id: string
    label: string
    revision: number
    reversed: boolean
    createdAt: number
    updatedAt: number
  }> = []
  await accessCanvasDocument(userId, projectId, async (_doc, tx) => {
    history = await tx
      .select(summaryFields)
      .from(commands)
      .where(and(eq(commands.project_id, projectId), ne(commands.before, '')))
      .orderBy(desc(commands.created_at), desc(commands.id))
      .limit(64)
    return undefined
  })
  return history
}

/** Optimistic revision makes retries and two simultaneously open browsers safe. */
export async function reverseStoredCanvasCommand(
  userId: string,
  projectId: string,
  id: string,
  revision: number,
) {
  return accessCanvasDocument(userId, projectId, async (doc, tx) => {
    const [command] = await tx
      .select()
      .from(commands)
      .where(and(eq(commands.project_id, projectId), eq(commands.id, id)))
    if (!command) throw new CanvasSyncError(404, 'canvas_command_not_found')
    if (!command.before) throw new CanvasSyncError(410, 'canvas_command_expired')
    if (command.revision !== revision) throw new CanvasSyncError(409, 'canvas_command_conflict')
    const record = reverseCanvasCommand(Y.encodeStateAsUpdate(doc), {
      before: decode(command.before),
      update: decode(command.update),
    })
    await tx
      .update(commands)
      .set({
        before: encode(record.before),
        update: encode(record.update),
        reversed: !command.reversed,
        revision: command.revision + 1,
        updated_at: Date.now(),
      })
      .where(eq(commands.id, id))
    return record.update
  })
}
