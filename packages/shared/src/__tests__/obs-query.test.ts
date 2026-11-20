import { describe, expect, it } from 'bun:test'
import {
  formatLog,
  formatTrace,
  logsSql,
  parseDuration,
  sqlString,
  taskSpansSql,
  traceSql,
} from '../obs-query'

describe('obs 查询拼装', () => {
  it('筛选条件拼成 WHERE，字段名用 OpenObserve 的小写形式', () => {
    expect(
      logsSql({ taskId: 't-1', service: 'worker', level: 'warn', grep: 'timeout', limit: 50 }),
    ).toBe(
      `SELECT * FROM "app" WHERE taskid = 't-1' AND service = 'worker' AND severity_number >= 13 AND str_match_ignore_case(body, 'timeout') ORDER BY _timestamp DESC LIMIT 50`,
    )
    expect(logsSql({ limit: 10 })).toBe('SELECT * FROM "app" ORDER BY _timestamp DESC LIMIT 10')
    expect(traceSql('abc')).toContain(`trace_id = 'abc'`)
    expect(traceSql('abc')).toMatch(/ORDER BY start_time, span_id$/)
    expect(taskSpansSql('t-1')).toContain(`task_id = 't-1'`)
    expect(taskSpansSql('t-1')).toMatch(/ORDER BY started, trace_id$/)
  })

  it('参数里的单引号不会打断查询', () => {
    expect(sqlString("a' OR '1'='1")).toBe("'a'' OR ''1''=''1'")
    expect(logsSql({ grep: "it's", limit: 1 })).toContain(`str_match_ignore_case(body, 'it''s')`)
  })

  it('时长：15m、2h、7d；别的写法报错', () => {
    expect(parseDuration('15m')).toBe(900_000)
    expect(parseDuration('2h')).toBe(7_200_000)
    expect(parseDuration('7d')).toBe(604_800_000)
    expect(() => parseDuration('1w')).toThrow()
    expect(() => parseDuration('h')).toThrow()
  })
})

describe('obs 输出排版', () => {
  it('一条日志一行：北京时间、级别、服务、事件、消息；任务、链路和其余字段缩进列在下面', () => {
    const line = formatLog({
      _timestamp: Date.UTC(2026, 10, 20, 4, 48, 0, 123) * 1_000,
      severity: 'ERROR',
      service: 'worker',
      event: 'upstream.failed',
      body: 'call failed',
      taskid: 't-1',
      trace_id: 'abc',
      container_id: 'hidden',
      time: 'hidden',
      upstream_model: 'gemini',
    })
    expect(line.split('\n')).toEqual([
      '11-20 12:48:00.123 ERROR worker upstream.failed  call failed',
      '    task=t-1',
      '    trace=abc',
      '    upstream_model=gemini',
    ])
  })

  it('span 排成树：相对起点、耗时、错误标记、关键属性和事件；父 span 不在结果里的当根', () => {
    const ms = 1_000_000
    const base = 1_795_000_000_000 * ms
    const tree = formatTrace([
      {
        span_id: 'c',
        reference_parent_span_id: 'a',
        start_time: base + 220 * ms,
        duration: 40_000,
        service_name: 'worker',
        operation_name: 'r2 write',
        span_status: 'UNSET',
        object_store_bytes: 5,
        events: '[]',
      },
      {
        span_id: 'a',
        reference_parent_span_id: 'from-another-process',
        start_time: base,
        duration: 260_000,
        service_name: 'worker',
        operation_name: 'task.execute',
        span_status: 'UNSET',
        task_id: 't-2',
        events: JSON.stringify([
          { _timestamp: 1, name: 'upstream.rate_limit_backoff', 'upstream.attempt': 1 },
        ]),
      },
      {
        span_id: 'b',
        reference_parent_span_id: 'a',
        start_time: base + 20 * ms,
        duration: 200_000,
        service_name: 'worker',
        operation_name: 'upstream POST',
        span_status: 'ERROR',
        http_response_status_code: 429,
      },
    ])
    expect(tree.split('\n')).toEqual([
      '+      0ms     260ms worker task.execute  task_id=t-2',
      '                      · upstream.rate_limit_backoff upstream.attempt=1',
      '+     20ms     200ms   worker upstream POST ✗  http_response_status_code=429',
      '+    220ms      40ms   worker r2 write  object_store_bytes=5',
    ])
    expect(formatTrace([])).toBe('（没有 span）')
  })
})
