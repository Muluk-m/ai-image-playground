import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const MAGIC = Buffer.from('AIPREC01')
const LIMIT = 64 * 1024 * 1024
export type RecoveryFile = { name: string; source: string }
export type RecoveryMetadata = {
  deployment: string
  publicCommit: string
  privateCommit: string | null
  image: string
  postgresMajor: number
}
type Bundle = {
  version: 1
  createdAt: string
  metadata: RecoveryMetadata
  files: { name: string; data: string; sha256: string }[]
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function keyBytes(key: string): Buffer {
  if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('Recovery key must be 32 random bytes in hex')
  return Buffer.from(key, 'hex')
}

function validateName(name: string): void {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(name) ||
    name.split('/').some((p) => !p || p === '.' || p === '..')
  ) {
    throw new Error('Invalid recovery file name')
  }
}

function validateMetadata(meta: RecoveryMetadata): void {
  if (
    !meta ||
    typeof meta.deployment !== 'string' ||
    !/^[a-z0-9-]+$/.test(meta.deployment) ||
    !/^[a-f0-9]{40}$/.test(meta.publicCommit) ||
    (meta.privateCommit !== null && !/^[a-f0-9]{40}$/.test(meta.privateCommit)) ||
    typeof meta.image !== 'string' ||
    !/^(?:[^\s]+@)?sha256:[a-f0-9]{64}$/.test(meta.image) ||
    !Number.isInteger(meta.postgresMajor) ||
    meta.postgresMajor < 17
  ) {
    throw new Error('Recovery metadata requires pinned commits, image and PostgreSQL major')
  }
}

/** Inventory is explicit: never recursively collect a home directory or follow symlinks. */
export async function sealBundle(
  metadata: RecoveryMetadata,
  inventory: RecoveryFile[],
  key: string,
): Promise<Buffer> {
  validateMetadata(metadata)
  const files: Bundle['files'] = []
  let total = 0
  const names = new Set<string>()
  for (const { name, source } of inventory) {
    validateName(name)
    if (names.has(name)) throw new Error('Duplicate recovery file name')
    names.add(name)
    const info = await lstat(source)
    if (!info.isFile() || info.size > LIMIT)
      throw new Error('Recovery input must be a bounded regular file')
    const data = await readFile(source)
    total += data.length
    if (total > LIMIT)
      throw new Error('Recovery bundle exceeds 64 MiB; use a streaming backup workflow')
    files.push({ name, data: data.toString('base64'), sha256: sha256(data) })
  }
  if (!files.length) throw new Error('Empty recovery inventory')
  const bundle: Bundle = { version: 1, createdAt: new Date().toISOString(), metadata, files }
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyBytes(key), nonce)
  cipher.setAAD(MAGIC)
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(bundle)), cipher.final()])
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), encrypted])
}

export function openBundle(bytes: Uint8Array, key: string): Bundle {
  const input = Buffer.from(bytes)
  if (input.length < 36 || input.length > LIMIT * 2 || !input.subarray(0, 8).equals(MAGIC))
    throw new Error('Invalid recovery envelope')
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(key), input.subarray(8, 20))
  decipher.setAAD(MAGIC)
  decipher.setAuthTag(input.subarray(20, 36))
  const bundle: Bundle = JSON.parse(
    Buffer.concat([decipher.update(input.subarray(36)), decipher.final()]).toString(),
  )
  if (bundle.version !== 1 || !Array.isArray(bundle.files) || !bundle.files.length)
    throw new Error('Invalid recovery bundle')
  validateMetadata(bundle.metadata)
  const names = new Set<string>()
  for (const file of bundle.files) {
    validateName(file.name)
    if (names.has(file.name) || sha256(Buffer.from(file.data, 'base64')) !== file.sha256)
      throw new Error('Recovery file integrity check failed')
    names.add(file.name)
  }
  // A file cannot also be another file's parent directory.
  for (const name of names) {
    const parts = name.split('/')
    while (parts.length > 1) {
      parts.pop()
      if (names.has(parts.join('/'))) throw new Error('Conflicting recovery paths')
    }
  }
  return bundle
}

/** Refuse an existing target (including symlinks). Nothing is activated or executed on extract. */
export async function extractBundle(
  bytes: Uint8Array,
  key: string,
  destination: string,
): Promise<RecoveryMetadata> {
  const bundle = openBundle(bytes, key)
  await mkdir(destination, { mode: 0o700 })
  for (const file of bundle.files) {
    const target = join(destination, file.name)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, Buffer.from(file.data, 'base64'), { mode: 0o600, flag: 'wx' })
  }
  await writeFile(
    join(destination, '.recovery-metadata.json'),
    JSON.stringify({
      createdAt: bundle.createdAt,
      ...bundle.metadata,
      files: bundle.files.map(({ name, sha256 }) => ({ name, sha256 })),
    }),
    { mode: 0o600, flag: 'wx' },
  )
  return bundle.metadata
}
