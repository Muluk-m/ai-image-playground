import { app } from './app'
import { config } from './config'

config.assertValid()
app.listen(config.port)
console.log(`✓ admin server listening on http://localhost:${config.port}`)
