import { afterEach, describe, expect, it } from 'bun:test'
import { createCipheriv, randomBytes } from 'node:crypto'
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractBundle, openBundle, sealBundle } from '../../../../../scripts/lib/recovery-bundle'

const roots: string[] = []
const key = randomBytes(32).toString('hex')
const metadata = {
  deployment: 'paid',
  publicCommit: 'a'.repeat(40),
  privateCommit: 'b'.repeat(40),
  image: `sha256:${'c'.repeat(64)}`,
  postgresMajor: 17,
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'recovery-bundle-'))
  roots.push(root)
  const source = join(root, 'source')
  await writeFile(source, 'DATABASE_PASSWORD=fixture-only\n')
  return { root, source }
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('encrypted cold recovery bundle', () => {
  it('requires an immutable image identity instead of a mutable release tag', async () => {
    const { source } = await fixture()
    await expect(
      sealBundle({ ...metadata, image: 'app:latest' }, [{ name: 'app.env', source }], key),
    ).rejects.toThrow()
  })
  it('round trips exact bytes into a new protected directory without plaintext in the envelope', async () => {
    const { root, source } = await fixture()
    const bytes = await sealBundle(metadata, [{ name: 'config/app.env', source }], key)
    expect(bytes.includes(Buffer.from('fixture-only'))).toBe(false)
    const target = join(root, 'restore')
    expect(await extractBundle(bytes, key, target)).toEqual(metadata)
    expect(await readFile(join(target, 'config/app.env'), 'utf8')).toBe(
      await readFile(source, 'utf8'),
    )
    expect((await lstat(target)).mode & 0o777).toBe(0o700)
    expect((await lstat(join(target, 'config/app.env'))).mode & 0o777).toBe(0o600)
    await expect(extractBundle(bytes, key, target)).rejects.toThrow()
  })
  it('rejects corruption and wrong keys before creating any output', async () => {
    const { root, source } = await fixture()
    const bytes = await sealBundle(metadata, [{ name: 'app.env', source }], key)
    expect(() => openBundle(bytes, '0'.repeat(64))).toThrow()
    bytes[bytes.length - 1] ^= 1
    const target = join(root, 'restore')
    await expect(extractBundle(bytes, key, target)).rejects.toThrow()
    await expect(lstat(target)).rejects.toThrow()
  })
  it('rejects unsafe names, duplicate entries and symlink inputs', async () => {
    const { root, source } = await fixture()
    for (const name of ['../escape', '/absolute', 'dir/../escape', 'dir//file', 'dir/./file']) {
      await expect(sealBundle(metadata, [{ name, source }], key)).rejects.toThrow()
    }
    await expect(
      sealBundle(
        metadata,
        [
          { name: 'app.env', source },
          { name: 'app.env', source },
        ],
        key,
      ),
    ).rejects.toThrow()
    await symlink(source, join(root, 'link'))
    await expect(
      sealBundle(metadata, [{ name: 'app.env', source: join(root, 'link') }], key),
    ).rejects.toThrow()
  })
  it('rejects an authenticated but path-conflicting bundle before writing', async () => {
    const { root, source } = await fixture()
    const valid = openBundle(await sealBundle(metadata, [{ name: 'config', source }], key), key)
    valid.files.push({ ...valid.files[0], name: 'config/app.env' })
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), nonce)
    const magic = Buffer.from('AIPREC01')
    cipher.setAAD(magic)
    const data = Buffer.concat([cipher.update(JSON.stringify(valid)), cipher.final()])
    const bytes = Buffer.concat([magic, nonce, cipher.getAuthTag(), data])
    await expect(extractBundle(bytes, key, join(root, 'restore'))).rejects.toThrow('Conflicting')
  })
})
