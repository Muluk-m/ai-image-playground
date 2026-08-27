import { afterEach, describe, expect, it } from 'bun:test'
import { isAdminPostgres } from '../../lib/sql-dialect'

describe('admin SQL dialect', () => {
  const original = process.env.DATABASE_URL
  afterEach(() => {
    if (original === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = original
  })

  it('treats sqlite file paths as sqlite', () => {
    process.env.DATABASE_URL = '../../artifacts/image-playground.sqlite'
    expect(isAdminPostgres()).toBe(false)
  })

  it('treats postgres URLs as postgres', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/image'
    expect(isAdminPostgres()).toBe(true)
  })
})
