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
    createSchema: false,
    writeTable: false,
    writeSequence: false,
    securityDefiner: false,
  }

  it('accepts a role with no write path', () => {
    expect(databaseRoleWriteReason(clean)).toBeNull()
  })

  it('names the write path it found', () => {
    expect(databaseRoleWriteReason({ ...clean, superuser: true })).toContain('superuser')
    expect(databaseRoleWriteReason({ ...clean, writeTable: true })).toContain('INSERT')
    expect(databaseRoleWriteReason({ ...clean, createSchema: true })).toContain('CREATE')
    expect(databaseRoleWriteReason({ ...clean, securityDefiner: true })).toContain(
      'SECURITY DEFINER',
    )
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

  it('refuses a SELECT-only login that can SET ROLE to a writable role', async () => {
    const login = roleName('aip_ro_member')
    const writerRole = roleName('aip_w_group')
    await createLogin(login)
    await exec(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${login}`)
    created.push(writerRole)
    await exec(`CREATE ROLE ${writerRole} NOLOGIN`)
    await exec(`GRANT INSERT ON TABLE users TO ${writerRole}`)
    await exec(`ALTER ROLE ${login} NOINHERIT`)
    await exec(`GRANT ${writerRole} TO ${login}`)
    await expect(assertAdminDatabaseIsReadOnly(urlFor(login))).rejects.toThrow(/INSERT/)
  })

  it('refuses column-level writes and writes through an updatable view', async () => {
    const columnWriter = roleName('aip_ro_column')
    const viewWriter = roleName('aip_ro_view')
    await createLogin(columnWriter)
    await exec(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${columnWriter}`)
    await exec(`GRANT UPDATE (status) ON TABLE tasks TO ${columnWriter}`)
    await expect(assertAdminDatabaseIsReadOnly(urlFor(columnWriter))).rejects.toThrow(/INSERT/)

    await createLogin(viewWriter)
    await exec(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${viewWriter}`)
    await exec(`GRANT UPDATE ON TABLE queue_tasks TO ${viewWriter}`)
    await expect(assertAdminDatabaseIsReadOnly(urlFor(viewWriter))).rejects.toThrow(/INSERT/)
  })

  it('refuses CREATE on any non-system schema', async () => {
    const login = roleName('aip_ro_schema')
    const schemaName = roleName('aip_extra')
    await createLogin(login)
    await exec(`CREATE SCHEMA ${schemaName}`)
    await exec(`GRANT CREATE ON SCHEMA ${schemaName} TO ${login}`)
    try {
      await expect(assertAdminDatabaseIsReadOnly(urlFor(login))).rejects.toThrow(/CREATE/)
    } finally {
      await exec(`DROP SCHEMA ${schemaName} CASCADE`)
    }
  })

  it('refuses an executable SECURITY DEFINER function', async () => {
    const login = roleName('aip_ro_secdef')
    const fn = roleName('aip_secdef_fn')
    await createLogin(login)
    await exec(
      `CREATE FUNCTION public.${fn}() RETURNS void LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`,
    )
    try {
      await expect(assertAdminDatabaseIsReadOnly(urlFor(login))).rejects.toThrow(/SECURITY DEFINER/)
    } finally {
      await exec(`DROP FUNCTION public.${fn}()`)
    }
  })
})
