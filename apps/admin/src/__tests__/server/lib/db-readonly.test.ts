import { afterAll, describe, expect, it } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { createDb } from '@image-playground/db'
import { resetTestDatabase } from '@image-playground/db/testing'
import {
  assertAdminDatabaseIsReadOnly,
  databaseRoleWriteReason,
} from '../../../../server/lib/db-readonly'

const databaseUrl = await resetTestDatabase('admin_db_readonly')
const admin = createDb(databaseUrl)
const created: string[] = []

function roleName(prefix: string): string {
  return `${prefix}_${randomBytes(4).toString('hex')}`
}

async function exec(statement: string): Promise<void> {
  await admin.client.unsafe(statement)
}

async function createLogin(name: string): Promise<void> {
  created.push(name)
  const [{ name: database }] = await admin.client`SELECT current_database() AS name`
  await exec(`CREATE ROLE ${name} LOGIN PASSWORD 'readonly-test-password'`)
  await exec(`GRANT CONNECT ON DATABASE ${String(database)} TO ${name}`)
  await exec(`GRANT USAGE ON SCHEMA public TO ${name}`)
}

function urlFor(role: string): string {
  const url = new URL(databaseUrl)
  url.username = role
  url.password = 'readonly-test-password'
  return url.toString()
}

afterAll(async () => {
  for (const name of created.reverse()) {
    await exec(`DROP OWNED BY ${name}`).catch(() => {})
    await exec(`DROP ROLE IF EXISTS ${name}`).catch(() => {})
  }
  await admin.close()
})

describe('databaseRoleWriteReason', () => {
  const clean = {
    role: 'aip_admin',
    superuser: false,
    writeAllData: false,
    createPublic: false,
    writeTable: false,
    writeSequence: false,
  }

  it('accepts a role with no write path', () => {
    expect(databaseRoleWriteReason(clean)).toBeNull()
  })

  it('names the write path it found', () => {
    expect(databaseRoleWriteReason({ ...clean, superuser: true })).toContain('superuser')
    expect(databaseRoleWriteReason({ ...clean, writeTable: true })).toContain('INSERT')
  })
})

describe('assertAdminDatabaseIsReadOnly', () => {
  it('refuses the writable test role', async () => {
    await expect(assertAdminDatabaseIsReadOnly(databaseUrl)).rejects.toThrow('not read-only')
  })

  it('accepts a SELECT-only role and refuses one that can insert', async () => {
    const reader = roleName('aip_ro')
    const writer = roleName('aip_rw')
    await createLogin(reader)
    await exec(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${reader}`)
    await exec(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${reader}`)
    await expect(assertAdminDatabaseIsReadOnly(urlFor(reader))).resolves.toBeUndefined()

    await createLogin(writer)
    await exec(`GRANT SELECT, INSERT ON TABLE users TO ${writer}`)
    await expect(assertAdminDatabaseIsReadOnly(urlFor(writer))).rejects.toThrow(
      /INSERT|not read-only/,
    )
  })
})
