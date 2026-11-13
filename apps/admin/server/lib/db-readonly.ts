import { createDb } from '@image-playground/db'
import type { SQL as BunSQL } from 'bun'

export interface DatabaseWriteProbe {
  role: string
  superuser: boolean
  writeAllData: boolean
  createPublic: boolean
  writeTable: boolean
  writeSequence: boolean
}

/** 为什么这个角色不能当 Admin 用。没有原因就是只读。 */
export function databaseRoleWriteReason(probe: DatabaseWriteProbe): string | null {
  const reasons: string[] = []
  if (probe.superuser) reasons.push('superuser')
  if (probe.writeAllData) reasons.push('member of pg_write_all_data')
  if (probe.createPublic) reasons.push('CREATE on schema public')
  if (probe.writeTable) reasons.push('owns a table or can INSERT, UPDATE, DELETE, or TRUNCATE')
  if (probe.writeSequence) reasons.push('owns a sequence or can UPDATE one')
  if (reasons.length === 0) return null
  return `ADMIN_DATABASE_URL role "${probe.role}" is not read-only (${reasons.join('; ')}). Use the SELECT-only role from provision.`
}

/**
 * Admin 启动时确认 DATABASE_URL（entrypoint 里的 ADMIN_DATABASE_URL）不能写。
 * 不看 default_transaction_read_only：那个默认值角色自己就能关掉。
 * 配错就拒绝启动，避免下一次误加的写语句直接生效。
 */
export async function assertAdminDatabaseIsReadOnly(databaseUrl: string): Promise<void> {
  const handle = createDb(databaseUrl, {
    max: 1,
    applicationName: 'aip-admin-readonly-check',
    idleTimeout: 5,
  })
  try {
    const client = handle.client as BunSQL
    const [row] = await client`
      SELECT
        current_user AS role,
        r.rolsuper AS superuser,
        pg_has_role(current_user, 'pg_write_all_data', 'MEMBER') AS write_all_data,
        has_schema_privilege(current_user, 'public', 'CREATE') AS create_public,
        EXISTS (
          SELECT 1
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND n.nspname NOT LIKE 'pg_%'
            AND c.relkind IN ('r', 'p', 'f')
            AND (
              pg_get_userbyid(c.relowner) = current_user
              OR has_table_privilege(current_user, c.oid, 'INSERT')
              OR has_table_privilege(current_user, c.oid, 'UPDATE')
              OR has_table_privilege(current_user, c.oid, 'DELETE')
              OR has_table_privilege(current_user, c.oid, 'TRUNCATE')
            )
        ) AS write_table,
        EXISTS (
          SELECT 1
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND n.nspname NOT LIKE 'pg_%'
            AND c.relkind = 'S'
            AND (
              pg_get_userbyid(c.relowner) = current_user
              OR has_sequence_privilege(current_user, c.oid, 'UPDATE')
            )
        ) AS write_sequence
      FROM pg_roles r
      WHERE r.rolname = current_user
    `
    const reason = databaseRoleWriteReason({
      role: String(row?.role ?? ''),
      superuser: Boolean(row?.superuser),
      writeAllData: Boolean(row?.write_all_data),
      createPublic: Boolean(row?.create_public),
      writeTable: Boolean(row?.write_table),
      writeSequence: Boolean(row?.write_sequence),
    })
    if (reason) throw new Error(reason)
  } finally {
    await handle.close()
  }
}
