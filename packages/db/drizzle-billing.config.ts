import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schemas/billing.ts',
  out: './drizzle-billing',
  migrations: {
    schema: 'private_billing',
    table: 'migrations',
  },
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      'postgresql://image_playground:change-me@127.0.0.1:5432/image_playground',
  },
})
