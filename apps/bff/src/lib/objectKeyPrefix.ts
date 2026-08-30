/** Returns '' or a slash-terminated prefix, so callers can concatenate a key directly. */
export function normalizeKeyPrefix(raw: string | undefined): string {
  const trimmed = (raw ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '')
  return trimmed ? `${trimmed}/` : ''
}
