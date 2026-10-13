/// <reference lib="webworker" />
import { StreamTarget, type StreamTargetChunk } from 'mediabunny'
import { type ComposeClip, ComposeError, type ComposeFailure, composeFilm } from './composeFilm'

export type FilmWorkerRequest =
  | { type: 'start'; count: number }
  | { type: 'clip'; clip: ComposeClip }
  | { type: 'written' }

export type FilmWorkerResponse =
  | { type: 'clip'; index: number }
  | { type: 'write'; chunk: StreamTargetChunk }
  | { type: 'progress'; fraction: number }
  | { type: 'done' }
  | { type: 'failed'; reason: ComposeFailure | 'encode'; position?: number; message: string }

const scope = self as unknown as DedicatedWorkerGlobalScope
const post = (message: FilmWorkerResponse, transfer: Transferable[] = []) =>
  scope.postMessage(message, transfer)
let receiveClip: ((clip: ComposeClip) => void) | undefined
let receiveWrite: (() => void) | undefined
let started = false

scope.onmessage = async (event: MessageEvent<FilmWorkerRequest>) => {
  const message = event.data
  if (message.type === 'clip') {
    const receive = receiveClip
    receiveClip = undefined
    receive?.(message.clip)
    return
  }
  if (message.type === 'written') {
    const receive = receiveWrite
    receiveWrite = undefined
    receive?.()
    return
  }
  if (started) return
  started = true
  try {
    const target = new StreamTarget(
      new WritableStream<StreamTargetChunk>({
        write(chunk) {
          return new Promise<void>((resolve) => {
            receiveWrite = resolve
            const data = chunk.data.slice()
            post({ type: 'write', chunk: { ...chunk, data } }, [data.buffer])
          })
        },
      }),
      { chunked: true, chunkSize: 2 ** 20 },
    )
    await composeFilm(
      message.count,
      (index) =>
        new Promise((resolve) => {
          receiveClip = resolve
          post({ type: 'clip', index })
        }),
      target,
      (fraction) => post({ type: 'progress', fraction }),
    )
    post({ type: 'done' })
  } catch (err) {
    post(
      err instanceof ComposeError
        ? { type: 'failed', reason: err.reason, position: err.position, message: err.message }
        : {
            type: 'failed',
            reason: 'encode',
            message: err instanceof Error ? err.message : String(err),
          },
    )
  }
}
