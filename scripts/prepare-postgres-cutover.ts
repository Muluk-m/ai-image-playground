import { prepareSqliteCutover } from '../packages/db/src/sqlite-cutover'

const sqlitePath = process.env.SQLITE_DATABASE_PATH?.trim()
const backupPath = process.env.SQLITE_BACKUP_PATH?.trim()

if (!sqlitePath) throw new Error('SQLITE_DATABASE_PATH is required')
if (!backupPath) throw new Error('SQLITE_BACKUP_PATH is required')

const result = prepareSqliteCutover(sqlitePath, backupPath)
console.log(JSON.stringify({ event: 'sqlite_cutover.ready', ...result }))
