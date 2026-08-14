import { defineConfig } from 'drizzle-kit'
import { config } from './src/config'

export default defineConfig({
  dialect: 'sqlite',
  schema: '../../packages/db/src/schema.ts',
  out: './drizzle/migrations',
  dbCredentials: { url: config.databaseUrl },
})
