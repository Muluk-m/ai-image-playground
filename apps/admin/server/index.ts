import { config, loadAdminCapabilities } from './config'

await loadAdminCapabilities()
config.assertValid()
const { app } = await import('./app')
app.listen(config.port)
console.log(`✓ admin server listening on http://localhost:${config.port}`)
