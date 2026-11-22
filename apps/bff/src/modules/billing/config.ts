import {
  DEFAULT_RECHARGE_AMOUNTS_YUAN,
  DEFAULT_RECHARGE_CREDITS_PER_YUAN,
  MAX_CREDIT_BALANCE,
} from '@image-playground/shared'
import { dayInTimezone } from './calculations'

const DEFAULT_WELCOME_CREDITS = 2_000

// 非法值 fail-fast：静默回默认会让运维以为改生效了。
export function parseWelcomeCredits(raw: string | undefined): number {
  const trimmed = raw?.trim()
  if (!trimmed) return DEFAULT_WELCOME_CREDITS
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_CREDIT_BALANCE) {
    throw new Error('WELCOME_CREDITS must be a positive integer within credit limits')
  }
  return value
}

export const welcomeCredits = parseWelcomeCredits(process.env.WELCOME_CREDITS)

const DEFAULT_DEPLOYMENT_TIMEZONE = 'Asia/Shanghai'

// 非法时区 fail-fast：静默回默认会让整张热力图按错误的日界切日，而没有任何报错。
export function parseDeploymentTimezone(raw: string | undefined): string {
  const trimmed = raw?.trim()
  if (!trimmed) return DEFAULT_DEPLOYMENT_TIMEZONE
  try {
    dayInTimezone(Date.now(), trimmed)
  } catch {
    throw new Error('DEPLOYMENT_TIMEZONE must be an IANA time zone name')
  }
  return trimmed
}

export const deploymentTimezone = parseDeploymentTimezone(process.env.DEPLOYMENT_TIMEZONE)

const MAX_RECHARGE_CREDITS_PER_YUAN = Math.floor(MAX_CREDIT_BALANCE / 10)

export function parseRechargeCreditsPerYuan(raw: string | undefined): number {
  const trimmed = raw?.trim()
  if (!trimmed) return DEFAULT_RECHARGE_CREDITS_PER_YUAN
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_RECHARGE_CREDITS_PER_YUAN) {
    throw new Error(
      'BILLING_RECHARGE_CREDITS_PER_YUAN must be a positive integer within credit limits',
    )
  }
  return value
}

export function parseRechargeAmountsYuan(
  raw: string | undefined,
  creditsPerYuan: number = DEFAULT_RECHARGE_CREDITS_PER_YUAN,
): readonly number[] {
  const trimmed = raw?.trim()
  const parts = trimmed ? trimmed.split(',').map((part) => part.trim()) : null
  const amounts = parts ? parts.map((part) => Number(part)) : [...DEFAULT_RECHARGE_AMOUNTS_YUAN]
  if (
    amounts.length === 0 ||
    parts?.some((part) => !part) ||
    amounts.some(
      (yuan) =>
        !Number.isSafeInteger(yuan) || yuan < 10 || yuan * creditsPerYuan > MAX_CREDIT_BALANCE,
    ) ||
    new Set(amounts).size !== amounts.length
  ) {
    throw new Error(
      'BILLING_RECHARGE_AMOUNTS_YUAN must be a comma-separated list of distinct integers >= 10 within credit limits',
    )
  }
  return amounts
}

export const rechargeCreditsPerYuan = parseRechargeCreditsPerYuan(
  process.env.BILLING_RECHARGE_CREDITS_PER_YUAN,
)
export const rechargeAmountsYuan = parseRechargeAmountsYuan(
  process.env.BILLING_RECHARGE_AMOUNTS_YUAN,
  rechargeCreditsPerYuan,
)
