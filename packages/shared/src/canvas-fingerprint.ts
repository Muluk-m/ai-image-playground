/** Compact content identity for stale-result and confirmation checks, not authentication. */
export function canvasFingerprint(text: string): string {
  // Two independent 32-bit accumulators, versioned so future context rules can invalidate safely.
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < text.length; index++) {
    first = Math.imul(first ^ text.charCodeAt(index), 0x01000193)
    second = Math.imul(second ^ text.charCodeAt(index), 0x85ebca6b)
  }
  return `v1:${text.length}:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`
}
