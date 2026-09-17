import { currentLocale } from './index'

/**
 * 日期与数字一律走这里，不要再写 `toLocaleString('zh-CN')`。写死 locale 的地方在切到英文后
 * 仍然吐中文格式，是最容易漏掉的一类「没翻干净」。
 */

const DATE_TIME: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
}

const DATE_ONLY: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}

const DATE_MINUTE: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
}

function toDate(value: Date | number | string): Date {
  return value instanceof Date ? value : new Date(value)
}

export function formatDateTime(value: Date | number | string): string {
  return new Intl.DateTimeFormat(currentLocale(), DATE_TIME).format(toDate(value))
}

export function formatDate(value: Date | number | string): string {
  return new Intl.DateTimeFormat(currentLocale(), DATE_ONLY).format(toDate(value))
}

/** 日期加时分，不要秒。账单、订阅到期这类场景要的是这一档。 */
export function formatDateMinute(value: Date | number | string): string {
  return new Intl.DateTimeFormat(currentLocale(), DATE_MINUTE).format(toDate(value))
}

export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(currentLocale(), options).format(value)
}

/** 整数计数，例如积分余额。千分位跟着 locale 走。 */
export function formatCount(value: number): string {
  return formatNumber(Math.round(value), { maximumFractionDigits: 0 })
}

/** 顿号在英文里不存在。列举的分隔符跟着 locale 走，别把中文标点带进英文界面。 */
export function joinList(items: readonly string[]): string {
  return items.join(currentLocale() === 'zh-CN' ? '、' : ', ')
}

/** 两条各自独立的提示并排显示时的分隔。 */
export function joinNotices(items: readonly string[]): string {
  return items.join(currentLocale() === 'zh-CN' ? '；' : '; ')
}
