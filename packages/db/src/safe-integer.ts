import { type SQL, sql } from 'drizzle-orm'

/**
 * 文本先匹配 1–9 位数字再转 integer。空串、小数、符号和非数字得到 NULL，
 * 不会让整条语句因为 `::integer` 失败。`coalesce` 救不了转换错误：PostgreSQL 先做转换。
 */
export function sqlIntegerFromDigitText(value: SQL): SQL {
  return sql`CASE WHEN btrim((${value})::text) ~ '^[0-9]{1,9}$' THEN btrim((${value})::text)::integer ELSE NULL END`
}

/** 非法文本落到 fallback，而不是把查询打成 500。 */
export function sqlCoalesceIntegerFromDigitText(value: SQL, fallback: SQL): SQL {
  return sql`COALESCE(${sqlIntegerFromDigitText(value)}, ${fallback})`
}

/** 累加时跳过非法文本，按 0 计，路由计数里的脏值不会让整页运维看板失败。 */
export function sqlSumIntegerFromDigitText(value: SQL): SQL {
  return sql`SUM(COALESCE(${sqlIntegerFromDigitText(value)}, 0))`
}

/**
 * 批次当前 attempt。键不存在时是 1。文本不是 1–9 位数字时是 NULL，
 * 连接不上任何 attempt，避免把空串或小数当成第一次尝试。
 */
export function sqlBatchAttemptTarget(value: SQL): SQL {
  return sql`CASE WHEN (${value}) IS NULL THEN 1 WHEN btrim((${value})::text) ~ '^[0-9]{1,9}$' THEN btrim((${value})::text)::integer ELSE NULL END`
}
