import { randomBytes } from 'node:crypto'
import { isValidUsername, normalizeUsername } from '@image-playground/shared'

const MAX_BASE_LENGTH = 24

function sanitize(value: string): string {
  return normalizeUsername(value)
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_BASE_LENGTH)
}

/** A taken address falls back to suffixed local-part handles: `local-2@host` is not an address. */
export function oauthUsernameCandidates(input: {
  provider: string
  subject: string
  email: string | null
}): string[] {
  const candidates: string[] = []
  const email = input.email ? normalizeUsername(input.email) : null
  if (email && isValidUsername(email)) candidates.push(email)

  const localPart = sanitize(email?.split('@')[0] ?? '')
  const seed = localPart.length >= 3 ? localPart : sanitize(`${input.provider}-${input.subject}`)

  candidates.push(seed)
  for (let suffix = 2; suffix <= 9; suffix++) candidates.push(`${seed}-${suffix}`)
  candidates.push(`${seed}-${randomBytes(3).toString('hex')}`)
  return candidates.filter(isValidUsername)
}
