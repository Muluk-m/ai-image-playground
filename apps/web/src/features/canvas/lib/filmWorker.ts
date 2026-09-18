/// <reference lib="webworker" />
import { type ComposeClip, ComposeError, type ComposeFailure, composeFilm } from './composeFilm'

export interface FilmWorkerRequest {
  clips: ComposeClip[]
}

export type FilmWorkerResponse =
  | { type: 'progress'; fraction: number }
  | { type: 'done'; buffer: ArrayBuffer }
  | { type: 'failed'; reason: ComposeFailure | 'encode'; position?: number; message: string }

const scope = self as unknown as DedicatedWorkerGlobalScope

scope.onmessage = async (event: MessageEvent<FilmWorkerRequest>) => {
  const post = (message: FilmWorkerResponse, transfer: Transferable[] = []) =>
    scope.postMessage(message, transfer)
  try {
    const buffer = await composeFilm(event.data.clips, (fraction) =>
      post({ type: 'progress', fraction }),
    )
    post({ type: 'done', buffer }, [buffer])
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
