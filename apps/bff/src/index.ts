import { config } from './config'
import { runMigrations } from './db/migrate'
import { app } from './app'

runMigrations()

if (config.corsOrigins === '*') {
  console.warn(
    '[bff] ⚠️  CORS_ALLOWED_ORIGINS=*：任何 origin 的浏览器都能调本 BFF + 消耗 sub2api 配额。' +
      '生产应限制为前端实际 origin（如 https://image-playground.qiliangjia.one）。',
  )
}

app.listen(config.port, () => {
  console.log(`[bff] listening on http://localhost:${config.port}`)
  console.log(`[bff] upstream sub2api: ${config.sub2api.baseUrl}`)
  console.log(`[bff] cors origins: ${config.corsOrigins}`)
})
