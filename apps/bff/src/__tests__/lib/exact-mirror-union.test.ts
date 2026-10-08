import { describe, expect, it } from 'bun:test'
import { Elysia, t } from 'elysia'

/**
 * elysia 1.4 把 `@sinclair/typebox` 的 TypeCompiler 传给 exact-mirror。
 * exact-mirror 1.x 改成只要 typebox 1 的 `Compile`，缺了就对每个 Union
 * `console.warn(new Error(...))`，生产日志会被整段堆栈刷成 warn/error。
 * 0.2.7 认 `TypeCompiler`，Union 会按声明裁掉多余字段，并且不再警告。
 */
describe('exact-mirror union normalization', () => {
  it('compiles a union body without the TypeCompiler warning', async () => {
    const warnings: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '))
      original(...args)
    }
    try {
      const app = new Elysia().post('/union', ({ body }) => body, {
        body: t.Object({
          value: t.Union([t.String(), t.Number()]),
        }),
      })
      const response = await app.handle(
        new Request('http://localhost/union', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ value: 'ok', extra: true }),
        }),
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ value: 'ok' })
      expect(warnings.join('\n')).not.toContain('exact-mirror')
    } finally {
      console.warn = original
    }
  })
})
