import { config } from './config'
import { runMigrations } from './db/migrate'
import { app } from './app'

runMigrations()

app.listen(config.port, () => {
  console.log(`[bff] listening on http://localhost:${config.port}`)
  console.log(`[bff] upstream sub2api: ${config.sub2api.baseUrl}`)
})
