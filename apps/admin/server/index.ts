import { config, loadAdminCapabilities } from './config'

config.assertValid()
await loadAdminCapabilities()
const { app } = await import('./app')
app.listen(config.port)
console.log(`✓ admin server listening on http://localhost:${config.port}`)
