import { assertOperatorConsoleEnabled, config } from './config'

config.assertValid()
await assertOperatorConsoleEnabled()
const { app } = await import('./app')
app.listen(config.port)
console.log(`✓ admin server listening on http://localhost:${config.port}`)
