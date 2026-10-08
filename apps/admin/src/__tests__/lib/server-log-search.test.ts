import { defaultParseSearch, defaultStringifySearch } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import {
  formatLogExpression,
  LOG_RANGES,
  logTrendSelection,
  parseLogExpression,
  parseServerLogSearch,
  serverLogFilters,
} from '../../lib/server-log-search'

describe('field search', () => {
  it('parses exact fields, quoted values and literal URL text', () => {
    expect(
      parseLogExpression('service:worker level:error container:"old worker" https://host timeout'),
    ).toEqual({
      service: 'worker',
      level: 'error',
      instance: 'old worker',
      q: 'https://host timeout',
    })
    expect(parseLogExpression('stream:stderr deployment:paid taskId:t-1')).toEqual({
      stream: 'stderr',
      deployment: 'paid',
      taskId: 't-1',
      q: undefined,
    })
    expect(() => parseLogExpression('level:unknown')).toThrow('日志级别无效')
    expect(() => parseLogExpression('stream:unknown')).toThrow()
    expect(() => parseLogExpression('x'.repeat(401))).toThrow('关键词不能超过 400 个字符')
    expect(() => parseLogExpression('service:bff ' + 'x'.repeat(401))).toThrow()
  })
})

describe('shareable server log queries', () => {
  it('preserves exact event groups with whitespace through route and share serialization', () => {
    for (const group of [' leading ', `${'x'.repeat(399)} `, '  ']) {
      const search = parseServerLogSearch({ group })
      expect(search.group).toBe(group)
      expect(parseServerLogSearch(defaultParseSearch(defaultStringifySearch(search))).group).toBe(
        group,
      )
    }
  })
  it('restores a frozen query and exact correlations without a cursor', () => {
    const to = Date.now()
    const search = parseServerLogSearch({
      from: String(to - LOG_RANGES['24h']),
      to: String(to),
      service: 'bff',
      level: 'warn',
      userId: 'u-1',
      mediaId: 'm-1',
      requestId: 'r-1',
      instance: 'bff-old',
      version: 'release-old',
      cursor: 'untrusted',
    })
    expect(search).toEqual({
      from: to - LOG_RANGES['24h'],
      to,
      service: 'bff',
      level: 'warn',
      userId: 'u-1',
      mediaId: 'm-1',
      requestId: 'r-1',
      instance: 'bff-old',
      version: 'release-old',
    })
    expect(serverLogFilters(search)).not.toHaveProperty('from')
  })
  it('rejects invalid windows and unknown service, level and range', () => {
    const to = Date.now()
    expect(
      parseServerLogSearch({
        from: to - 8 * 86400_000,
        to,
        service: 'all',
        level: 'panic',
        range: '30d',
      }),
    ).toEqual({})
    expect(parseServerLogSearch({ from: to + 1000, to })).toEqual({})
    expect(parseServerLogSearch({ from: 0 })).toEqual({})
    expect(parseServerLogSearch({ range: 'toString' })).toEqual({})
    expect(parseServerLogSearch({ range: '24h', q: '  decode failed  ' })).toEqual({
      range: '24h',
      q: 'decode failed',
    })
  })
})

describe('trend selection', () => {
  it('ignores the empty last bucket at an exact end boundary', () => {
    expect(logTrendSelection(0, 60000, 60000, 60000, 60000)).toBeNull()
    expect(logTrendSelection(0, 60000, 0, 60000, 60000)).toEqual({ from: 0, to: 60000 })
  })
})

describe('expression serialization', () => {
  it('round trips literal field-like keywords without creating filters', () => {
    for (const q of [
      'level:error',
      'taskId:xxx',
      'q:literal',
      'level:error taskId:xxx',
      'both \' and " quotes',
      'line\nnext',
    ]) {
      const filters = { service: 'worker' as const, q }
      expect(parseLogExpression(formatLogExpression(filters))).toEqual(filters)
    }
    expect(() => parseLogExpression('q:"' + 'x'.repeat(401) + '"')).toThrow(
      '关键词不能超过 400 个字符',
    )
  })
  it('round trips exact quoted and escaped identities', () => {
    for (const instance of ['"abc"', 'both \' and " quotes', 'a\\b', 'line\nnext', ' leading ']) {
      const filters = { instance, q: 'timeout' }
      expect(parseLogExpression(formatLogExpression(filters))).toEqual(filters)
    }
  })
})
