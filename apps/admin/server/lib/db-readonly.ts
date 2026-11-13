import { createDb } from '@image-playground/db'
import type { SQL as BunSQL } from 'bun'

export interface DatabaseWriteProbe {
  role: string
  superuser: boolean
  writeAllData: boolean
  createSchema: boolean
  writeTable: boolean
  writeSequence: boolean
  securityDefiner: boolean
}

/** 为什么这个角色不能当 Admin 用。没有原因就是只读。 */
export function databaseRoleWriteReason(probe: DatabaseWriteProbe): string | null {
  const reasons: string[] = []
  if (probe.superuser) reasons.push('superuser, or can SET ROLE to one')
  if (probe.writeAllData) reasons.push('member of pg_write_all_data')
  if (probe.createSchema) reasons.push('owns a schema, or has CREATE on one or on the database')
  if (probe.writeTable)
    reasons.push(
      'owns a table or view, or can INSERT, UPDATE, DELETE, or TRUNCATE (incl. per column)',
    )
  if (probe.writeSequence) reasons.push('owns a sequence or can UPDATE or nextval one')
  if (probe.securityDefiner) reasons.push('can EXECUTE a SECURITY DEFINER function')
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
    // 「能写」按当前角色和它通过成员关系可达的所有角色算：NOINHERIT 的成员仍能 SET ROLE 过去写。
    const [row] = await client`
      WITH reachable AS (
        SELECT oid, rolname, rolsuper
        FROM pg_roles
        WHERE pg_has_role(current_user, oid, 'MEMBER')
      ),
      user_schemas AS (
        SELECT oid, nspowner
        FROM pg_namespace
        WHERE nspname NOT IN ('pg_catalog', 'information_schema')
          AND nspname NOT LIKE 'pg_%'
      )
      SELECT
        current_user AS role,
        EXISTS (SELECT 1 FROM reachable WHERE rolsuper) AS superuser,
        pg_has_role(current_user, 'pg_write_all_data', 'MEMBER') AS write_all_data,
        EXISTS (
          SELECT 1
          FROM user_schemas s, reachable r
          WHERE s.nspowner = r.oid OR has_schema_privilege(r.oid, s.oid, 'CREATE')
        )
        -- 数据库级 CREATE 能新建 schema，再在里面建表写入。
        OR EXISTS (
          SELECT 1 FROM reachable r
          WHERE has_database_privilege(r.oid, current_database(), 'CREATE')
        ) AS create_schema,
        EXISTS (
          SELECT 1
          FROM pg_class c
          JOIN user_schemas s ON s.oid = c.relnamespace
          CROSS JOIN reachable r
          -- 简单视图可自动更新（如 queue_tasks）；列级 GRANT 不体现在表级权限里。
          WHERE c.relkind IN ('r', 'p', 'f', 'v', 'm')
            AND (
              c.relowner = r.oid
              OR has_table_privilege(r.oid, c.oid, 'INSERT')
              OR has_table_privilege(r.oid, c.oid, 'UPDATE')
              OR has_table_privilege(r.oid, c.oid, 'DELETE')
              OR has_table_privilege(r.oid, c.oid, 'TRUNCATE')
              OR has_any_column_privilege(r.oid, c.oid, 'INSERT')
              OR has_any_column_privilege(r.oid, c.oid, 'UPDATE')
            )
        ) AS write_table,
        EXISTS (
          SELECT 1
          FROM pg_class c
          JOIN user_schemas s ON s.oid = c.relnamespace
          CROSS JOIN reachable r
          WHERE c.relkind = 'S'
            -- nextval 只要 USAGE，推进不随事务回滚。
            AND (
              c.relowner = r.oid
              OR has_sequence_privilege(r.oid, c.oid, 'UPDATE')
              OR has_sequence_privilege(r.oid, c.oid, 'USAGE')
            )
        ) AS write_sequence,
        EXISTS (
          SELECT 1
          FROM pg_proc p
          JOIN user_schemas s ON s.oid = p.pronamespace
          CROSS JOIN reachable r
          WHERE p.prosecdef AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
        ) AS security_definer
    `
    const reason = databaseRoleWriteReason({
      role: String(row?.role ?? ''),
      superuser: Boolean(row?.superuser),
      writeAllData: Boolean(row?.write_all_data),
      createSchema: Boolean(row?.create_schema),
      writeTable: Boolean(row?.write_table),
      writeSequence: Boolean(row?.write_sequence),
      securityDefiner: Boolean(row?.security_definer),
    })
    if (reason) throw new Error(reason)
  } finally {
    await handle.close()
  }
}
