import { config, loadAdminCapabilities } from './config'
import { assertAdminDatabaseIsReadOnly } from './lib/db-readonly'

await loadAdminCapabilities()
config.assertValid()
await assertAdminDatabaseIsReadOnly(config.databaseUrl)
const { app } = await import('./app')
app.listen(config.port)
console.log(`✓ admin server listening on http://localhost:${config.port}`)
