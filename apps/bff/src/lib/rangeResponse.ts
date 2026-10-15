import type { ObjectRangeReader } from './objectStore'

export function rangeStreamResponse(
  object: ObjectRangeReader,
  mime: string,
  cacheControl: string,
  range: string | null,
): Response {
  const headers: Record<string, string> = {
    'content-type': mime,
    'cache-control': cacheControl,
    'accept-ranges': 'bytes',
  }
  const span = range === null ? null : parseByteRange(range, object.size)
  if (span === 'unsatisfiable') {
    headers['content-range'] = `bytes */${object.size}`
    return new Response(null, { status: 416, headers })
  }
  const { start, end } = span ?? { start: 0, end: object.size - 1 }
  headers['content-length'] = String(end - start + 1)
  if (span === null) return new Response(object.stream(start, end), { headers })
  headers['content-range'] = `bytes ${start}-${end}/${object.size}`
  return new Response(object.stream(start, end), { status: 206, headers })
}

export function parseByteRange(
  header: string,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) return null
  if (!rawStart) {
    const suffix = Number(rawEnd)
    if (suffix === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(rawStart)
  if (start >= size) return 'unsatisfiable'
  const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1
  if (end < start) return 'unsatisfiable'
  return { start, end }
}
