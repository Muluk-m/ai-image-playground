import { defineConfig } from 'drizzle-kit'
import { config } from './src/config'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle/migrations',
  dbCredentials: { url: config.databaseUrl },
})
