#!/usr/bin/env bun
import { randomBytes, randomUUID } from 'node:crypto'
import { lstat, readFile, writeFile } from 'node:fs/promises'
import { S3Client } from 'bun'
import {
  extractBundle,
  type RecoveryFile,
  type RecoveryMetadata,
  sealBundle,
  sha256,
} from './lib/recovery-bundle'

type Bootstrap = {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  prefix: string
  keyFile: string
}
const usage =
  'Usage: recovery-bundle.ts keygen <new-key-file> | list <bootstrap.json> | publish <bootstrap.json> <inventory.json> <receipt.json> | fetch <bootstrap.json> <receipt.json-or-object-key> <new-directory>'
let phase = 'argument validation'
async function privateFile(path: string): Promise<string> {
  const info = await lstat(path)
  if (!info.isFile() || info.mode & 0o077)
    throw new Error('Bootstrap and key files must be regular files with mode 0600')
  return readFile(path, 'utf8')
}

async function main() {
  const [command, ...args] = Bun.argv.slice(2)
  if (command === '--help') {
    console.log(usage)
    return
  }
  if (command === 'keygen' && args.length === 1) {
    await writeFile(args[0], `${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' })
    console.log('Created recovery key; store an independent protected copy before publishing')
    return
  }
  if (
    !(['publish', 'fetch'].includes(command ?? '') && args.length === 3) &&
    !(command === 'list' && args.length === 1)
  ) {
    console.error(usage)
    process.exitCode = 2
    return
  }
  phase = 'protected bootstrap and key validation'
  const config: Bootstrap = JSON.parse(await privateFile(args[0]))
  if (
    !/^https:\/\/[a-z0-9.-]+\.r2\.cloudflarestorage\.com$/.test(config.endpoint) ||
    !/^[a-z0-9][a-z0-9/-]*\/$/.test(config.prefix) ||
    config.prefix.includes('..')
  )
    throw new Error('Use an R2 HTTPS endpoint and a dedicated recovery prefix ending in /')
  const key = (await privateFile(config.keyFile)).trim()
  const s3 = new S3Client({ ...config, region: 'auto' })
  if (command === 'list') {
    phase = 'R2 listing'
    let continuationToken: string | undefined
    do {
      const page = await s3.list({ prefix: config.prefix, continuationToken })
      for (const object of page.contents ?? []) {
        if (object.key.endsWith('.sealed.complete.json'))
          console.log(object.key.replace(/\.complete\.json$/, ''))
      }
      continuationToken = page.isTruncated ? page.nextContinuationToken : undefined
      if (page.isTruncated && !continuationToken) throw new Error('Incomplete recovery listing')
    } while (continuationToken)
    return
  }
  if (command === 'publish') {
    phase = 'inventory validation and encryption'
    const inventory: { metadata: RecoveryMetadata; files: RecoveryFile[] } = JSON.parse(
      await privateFile(args[1]),
    )
    const bytes = await sealBundle(inventory.metadata, inventory.files, key)
    const object = `${config.prefix}${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.sealed`
    phase = 'R2 upload and read-back verification'
    await s3.file(object).write(bytes, { type: 'application/octet-stream' })
    // Prove that the stored bytes, not merely the local encryption, can be recovered.
    const remote = new Uint8Array(await s3.file(object).arrayBuffer())
    if (sha256(remote) !== sha256(bytes)) throw new Error('R2 round-trip checksum mismatch')
    const receipt = { version: 1, object, sha256: sha256(bytes), bytes: bytes.length }
    // Completion marker is last; incomplete uploads are never recovery candidates.
    await s3
      .file(`${object}.complete.json`)
      .write(JSON.stringify(receipt), { type: 'application/json' })
    await writeFile(args[2], `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    console.log(`Published and read-verified ${object}`)
  } else {
    phase = 'R2 completion marker and download verification'
    const remoteKey =
      args[1].startsWith(config.prefix) && !args[1].includes('..') && args[1].endsWith('.sealed')
    const receipt = remoteKey
      ? await s3.file(`${args[1]}.complete.json`).json()
      : JSON.parse(await readFile(args[1], 'utf8'))
    if (
      receipt.version !== 1 ||
      typeof receipt.object !== 'string' ||
      !receipt.object.startsWith(config.prefix) ||
      receipt.object.includes('..') ||
      !receipt.object.endsWith('.sealed')
    )
      throw new Error('Invalid recovery receipt')
    const completed = await s3.file(`${receipt.object}.complete.json`).json()
    if (
      completed.sha256 !== receipt.sha256 ||
      completed.object !== receipt.object ||
      completed.bytes !== receipt.bytes
    )
      throw new Error('Recovery completion marker mismatch')
    if (
      !Number.isSafeInteger(receipt.bytes) ||
      receipt.bytes <= 0 ||
      receipt.bytes > 128 * 1024 * 1024
    )
      throw new Error('Invalid recovery size')
    if ((await s3.stat(receipt.object)).size !== receipt.bytes)
      throw new Error('Recovery object size mismatch')
    const bytes = new Uint8Array(await s3.file(receipt.object).arrayBuffer())
    if (bytes.length !== receipt.bytes || sha256(bytes) !== receipt.sha256)
      throw new Error('Recovery download checksum mismatch')
    phase = 'authenticated decryption and extraction into a new directory'
    const metadata = await extractBundle(bytes, key, args[2])
    console.log(
      `Recovered ${metadata.deployment}; files are inactive, database restore and writer handoff remain required`,
    )
  }
}

main().catch(() => {
  // SDK errors can include request credentials or source paths. Never dump their objects.
  console.error(
    `Recovery failed during ${phase}. Check file permissions, inventory, key, R2 access and completion receipt. No service was activated.`,
  )
  process.exitCode = 1
})
