import pino from 'pino'
import type { log as appLog } from '../../lib/logger'

/** Redirects the app logger's output into an array: the lines a container would print. */
export function captureLogLines(logger: typeof appLog): string[] {
  const lines: string[] = []
  ;(logger as unknown as Record<symbol, unknown>)[pino.symbols.streamSym] = {
    write: (line: string) => {
      lines.push(line)
    },
  }
  return lines
}
