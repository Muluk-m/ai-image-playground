import { describe, expect, it } from 'bun:test'
import {
  parseDeploymentTimezone,
  parseRechargeAmountsYuan,
  parseRechargeCreditsPerYuan,
  parseWelcomeCredits,
} from '../../../modules/billing/config'

describe('parseWelcomeCredits', () => {
  it('grants 2000 credits when WELCOME_CREDITS is unset or blank', () => {
    expect(parseWelcomeCredits(undefined)).toBe(2_000)
    expect(parseWelcomeCredits('')).toBe(2_000)
    expect(parseWelcomeCredits('   ')).toBe(2_000)
  })

  it('takes the amount from WELCOME_CREDITS', () => {
    expect(parseWelcomeCredits('500')).toBe(500)
    expect(parseWelcomeCredits(' 12000 ')).toBe(12_000)
  })

  it('rejects a value that is not a positive integer', () => {
    for (const raw of ['0', '-100', '1.5', 'many']) {
      expect(() => parseWelcomeCredits(raw)).toThrow('WELCOME_CREDITS must be a positive integer')
    }
  })
})

describe('parseDeploymentTimezone', () => {
  it('cuts the day in Asia/Shanghai when DEPLOYMENT_TIMEZONE is unset or blank', () => {
    expect(parseDeploymentTimezone(undefined)).toBe('Asia/Shanghai')
    expect(parseDeploymentTimezone('')).toBe('Asia/Shanghai')
    expect(parseDeploymentTimezone('   ')).toBe('Asia/Shanghai')
  })

  it('takes the zone from DEPLOYMENT_TIMEZONE', () => {
    expect(parseDeploymentTimezone('UTC')).toBe('UTC')
    expect(parseDeploymentTimezone(' America/New_York ')).toBe('America/New_York')
  })

  it('rejects a value that is not an IANA time zone name', () => {
    for (const raw of ['Mars/Olympus', 'GMT+8', 'shanghai']) {
      expect(() => parseDeploymentTimezone(raw)).toThrow(
        'DEPLOYMENT_TIMEZONE must be an IANA time zone name',
      )
    }
  })
})

describe('parseRechargeCreditsPerYuan', () => {
  it('defaults to 400 when unset or blank', () => {
    expect(parseRechargeCreditsPerYuan(undefined)).toBe(400)
    expect(parseRechargeCreditsPerYuan('')).toBe(400)
    expect(parseRechargeCreditsPerYuan('   ')).toBe(400)
  })

  it('accepts positive integer overrides', () => {
    expect(parseRechargeCreditsPerYuan('500')).toBe(500)
  })

  it('rejects invalid numbers', () => {
    for (const raw of ['0', '-10', '1.5', 'abc']) {
      expect(() => parseRechargeCreditsPerYuan(raw)).toThrow(
        'BILLING_RECHARGE_CREDITS_PER_YUAN must be a positive integer',
      )
    }
  })
})

describe('parseRechargeAmountsYuan', () => {
  it('defaults to [10, 50, 100] when unset or blank', () => {
    expect(parseRechargeAmountsYuan(undefined)).toEqual([10, 50, 100])
    expect(parseRechargeAmountsYuan('')).toEqual([10, 50, 100])
  })

  it('parses custom comma-separated tiers', () => {
    expect(parseRechargeAmountsYuan('20, 50, 200', 400)).toEqual([20, 50, 200])
  })

  it('rejects duplicates, sub-10 amounts, non-integers, and credit overflow', () => {
    for (const raw of ['5,10', '10,10', '10,,20', '10.5', '10000000']) {
      expect(() => parseRechargeAmountsYuan(raw, 400)).toThrow('BILLING_RECHARGE_AMOUNTS_YUAN')
    }
  })
})
