import { SERVER_IDLE_TIMEOUT_SEC } from '@image-playground/shared'
import { app } from './app'
import { config } from './config'

app.listen({ port: config.port, idleTimeout: SERVER_IDLE_TIMEOUT_SEC })
console.log(`✓ admin server listening on http://localhost:${config.port}`)
