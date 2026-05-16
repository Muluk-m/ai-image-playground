import { describe, expect, it } from 'vitest'

import {
  parseDeviceDetailSearch,
  parseDevicesSearch,
  parseFullscreen,
  parseImgIdx,
  parseImgKind,
  parseRange,
  parseSort,
  parseTaskId,
} from '../../lib/search-params'

describe('search-params', () => {
  describe('parseRange', () => {
    it('passes valid values', () => {
      expect(parseRange('1d')).toBe('1d')
      expect(parseRange('7d')).toBe('7d')
      expect(parseRange('30d')).toBe('30d')
    })
    it('falls back on invalid / undefined', () => {
      expect(parseRange(undefined)).toBe('7d')
      expect(parseRange('99d')).toBe('7d')
      expect(parseRange(null)).toBe('7d')
      expect(parseRange(7)).toBe('7d')
    })
  })

  describe('parseSort', () => {
    it('passes valid values', () => {
      expect(parseSort('last_seen')).toBe('last_seen')
      expect(parseSort('today_count')).toBe('today_count')
      expect(parseSort('total_count')).toBe('total_count')
    })
    it('falls back on invalid', () => {
      expect(parseSort(undefined)).toBe('last_seen')
      expect(parseSort('first_seen')).toBe('last_seen')
    })
  })

  describe('parseTaskId', () => {
    it('passes trimmed non-empty short string', () => {
      expect(parseTaskId('abc123')).toBe('abc123')
      expect(parseTaskId('  abc  ')).toBe('abc')
    })
    it('rejects empty / non-string / too long', () => {
      expect(parseTaskId('')).toBeUndefined()
      expect(parseTaskId(undefined)).toBeUndefined()
      expect(parseTaskId(123)).toBeUndefined()
      expect(parseTaskId('a'.repeat(129))).toBeUndefined()
    })
  })

  describe('parseFullscreen', () => {
    it('accepts only "1" or 1', () => {
      expect(parseFullscreen('1')).toBe('1')
      expect(parseFullscreen(1)).toBe('1')
      expect(parseFullscreen('0')).toBeUndefined()
      expect(parseFullscreen(true)).toBeUndefined()
      expect(parseFullscreen(undefined)).toBeUndefined()
    })
  })

  describe('parseImgIdx', () => {
    it('passes non-negative int from number or string', () => {
      expect(parseImgIdx(0)).toBe(0)
      expect(parseImgIdx(3)).toBe(3)
      expect(parseImgIdx('5')).toBe(5)
    })
    it('rejects invalid', () => {
      expect(parseImgIdx(-1)).toBeUndefined()
      expect(parseImgIdx('abc')).toBeUndefined()
      expect(parseImgIdx(1000)).toBeUndefined()
      expect(parseImgIdx(1.5)).toBeUndefined()
      expect(parseImgIdx(undefined)).toBeUndefined()
    })
  })

  describe('parseImgKind', () => {
    it('accepts output / input', () => {
      expect(parseImgKind('output')).toBe('output')
      expect(parseImgKind('input')).toBe('input')
    })
    it('rejects other', () => {
      expect(parseImgKind('other')).toBeUndefined()
      expect(parseImgKind(undefined)).toBeUndefined()
    })
  })

  describe('parseDevicesSearch', () => {
    it('round-trip valid input', () => {
      expect(parseDevicesSearch({ range: '30d', sort: 'today_count' })).toEqual({
        range: '30d',
        sort: 'today_count',
      })
    })
    it('falls back on empty', () => {
      expect(parseDevicesSearch({})).toEqual({ range: '7d', sort: 'last_seen' })
    })
    it('falls back on garbage values', () => {
      expect(parseDevicesSearch({ range: 'bogus', sort: 'bogus' })).toEqual({
        range: '7d',
        sort: 'last_seen',
      })
    })
  })

  describe('parseDeviceDetailSearch', () => {
    it('round-trip full set', () => {
      expect(
        parseDeviceDetailSearch({
          range: '1d',
          task: 'task-1',
          fullscreen: '1',
          imgIdx: '2',
          imgKind: 'input',
        }),
      ).toEqual({
        range: '1d',
        task: 'task-1',
        fullscreen: '1',
        imgIdx: 2,
        imgKind: 'input',
      })
    })
    it('default range, others undefined when absent', () => {
      expect(parseDeviceDetailSearch({})).toEqual({
        range: '7d',
        task: undefined,
        fullscreen: undefined,
        imgIdx: undefined,
        imgKind: undefined,
      })
    })
  })
})
