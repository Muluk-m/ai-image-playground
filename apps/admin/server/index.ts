import { app } from './app'
import { config } from './config'

app.listen(config.port)
console.log(`✓ admin server listening on http://localhost:${config.port}`)
