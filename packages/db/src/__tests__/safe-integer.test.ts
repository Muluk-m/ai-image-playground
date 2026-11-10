import { afterAll, expect, it } from 'bun:test'
import { sql } from 'drizzle-orm'
import { createDb } from '../client'
import { sqlCoalesceIntegerFromDigitText, sqlSumIntegerFromDigitText } from '../safe-integer'
import { resetTestDatabase } from '../testing'

const url = await resetTestDatabase('db_safe_integer')
const handle = createDb(url)

afterAll(() => handle.close())

it('casts only 1-9 digit text and leaves decimals, blanks, and junk as the fallback', async () => {
  const rows = (await handle.db.execute(sql`
    SELECT v AS raw, ${sqlCoalesceIntegerFromDigitText(sql`v`, sql`1`)} AS n
    FROM (VALUES
      ('2'::text),
      ('1.5'::text),
      (''::text),
      ('abc'::text),
      (NULL::text),
      (' 7 '::text),
      ('1000000000'::text),
      ('0'::text),
      ('-1'::text)
    ) AS t(v)
  `)) as unknown as Array<{ raw: string | null; n: number }>
  expect(rows.map((row) => [row.raw, Number(row.n)])).toEqual([
    ['2', 2],
    ['1.5', 1],
    ['', 1],
    ['abc', 1],
    [null, 1],
    [' 7 ', 7],
    ['1000000000', 1],
    ['0', 0],
    ['-1', 1],
  ])
})

it('sums digit text and counts non-digits as zero', async () => {
  const rows = (await handle.db.execute(sql`
    SELECT ${sqlSumIntegerFromDigitText(sql`v`)} AS total
    FROM (VALUES ('2'::text), ('nope'::text), ('3'::text), (NULL::text), ('1.5'::text)) AS t(v)
  `)) as unknown as Array<{ total: number }>
  expect(Number(rows[0]?.total)).toBe(5)
})
