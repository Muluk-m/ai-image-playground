import { importLegacySqlite } from '../packages/db/src/legacy-sqlite-import'

const sqlitePath = process.env.SQLITE_DATABASE_PATH?.trim()
const databaseUrl = process.env.DATABASE_URL?.trim()

if (!sqlitePath) throw new Error('SQLITE_DATABASE_PATH is required')
if (!databaseUrl) throw new Error('DATABASE_URL is required')

const counts = await importLegacySqlite(sqlitePath, databaseUrl)
console.log(JSON.stringify({ event: 'legacy_sqlite_import.completed', ...counts }))
