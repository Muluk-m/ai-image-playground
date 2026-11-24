import {
  Bot,
  Clock,
  Cloud,
  Coins,
  Cpu,
  Crop,
  Film,
  FolderSync,
  Gauge,
  HardDrive,
  Hash,
  Image,
  KeyRound,
  Layers,
  LogIn,
  type LucideIcon,
  MailCheck,
  Maximize2,
  MessageSquare,
  Minimize2,
  Paperclip,
  ScanEye,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Trash2,
  UserPlus,
  Users,
  Wand2,
} from 'lucide-react'

import { ApiError } from '@/lib/api-client'
import type { OperatorSettingRow, OperatorSettingUnit } from '@/lib/types'

export interface DomainMeta {
  label: string
  icon: LucideIcon
  isPrivate?: boolean
}

export const DOMAIN_ORDER = [
  'accounts',
  'agent',
  'generation',
  'sync',
  'billing',
  'quota',
  'cli',
  'operator',
] as const

export const DOMAIN_META: Record<string, DomainMeta> = {
  accounts: { label: '账号', icon: Users },
  agent: { label: '智能体', icon: Bot },
  billing: { label: '计费', icon: Coins, isPrivate: true },
  generation: { label: '生成', icon: Sparkles },
  sync: { label: '同步', icon: Cloud },
  quota: { label: '配额', icon: Gauge },
  cli: { label: '命令行', icon: Terminal },
  operator: { label: '运营', icon: Shield },
}

export function getDomainMeta(domain: string): DomainMeta {
  return DOMAIN_META[domain] ?? { label: domain, icon: SlidersHorizontal }
}

const SETTING_KEY_ICONS: Record<string, LucideIcon> = {
  'accounts:local-recovery': KeyRound,
  'accounts:login': LogIn,
  'accounts:email-verification': MailCheck,
  'accounts:self-register': UserPlus,
  'accounts:sync': FolderSync,
  'agent:chat': MessageSquare,
  'agent:production': Wand2,
  'agent:attachments': Paperclip,
  'agent:bulk-attachments': Paperclip,
  'agent:edit-region': Crop,
  'generation:video': Film,
  'generation:daily-images': Image,
  'quota:daily': Gauge,
  'cli:api': Terminal,
  'operator:console': Shield,
}

export function getSettingIcon(row: OperatorSettingRow): LucideIcon {
  const exact = SETTING_KEY_ICONS[row.key]
  if (exact) return exact

  if (row.key.startsWith('billing:')) return Coins
  if (row.key.startsWith('agent:batch-')) return Layers
  if (row.key.startsWith('agent:compaction-')) return Minimize2
  if (row.key.startsWith('agent:visual-')) return ScanEye
  if (row.key.startsWith('agent:attachment-')) return Paperclip
  if (row.key.startsWith('cli:')) return Terminal
  if (row.key.includes('recycle')) return Trash2
  if (row.key.includes('video')) return Film
  if (row.key.includes('image')) return Image

  if (row.kind === 'quota') {
    switch (row.unit) {
      case 'bytes':
        return HardDrive
      case 'seconds':
      case 'minutes':
      case 'days':
        return Clock
      case 'tokens':
        return Cpu
      case 'pixels':
        return Maximize2
      case 'count':
        return Hash
      default:
        return Gauge
    }
  }

  return getDomainMeta(row.domain).icon
}

export function formatSettingValue(value: boolean | number, unit?: OperatorSettingUnit): string {
  if (typeof value === 'boolean') return value ? '开启' : '关闭'
  if (unit === 'bytes') {
    if (value % 1024 ** 3 === 0) return `${value / 1024 ** 3} GB`
    if (value % 1024 ** 2 === 0) return `${value / 1024 ** 2} MB`
    return `${value} bytes`
  }
  if (unit === 'seconds' && value % 60 === 0) return `${value / 60} 分钟`
  return `${value}${unit === 'seconds' ? ' 秒' : unit === 'minutes' ? ' 分钟' : unit === 'tokens' ? ' tokens' : unit === 'count' ? ' 条' : unit === 'pixels' ? ' px' : unit === 'days' ? ' 天' : ''}`
}

/** Parse display units without rounding or accepting a unit from another quota. */
export function parseSettingInput(value: string, unit?: OperatorSettingUnit): number {
  const match = value
    .trim()
    .match(/^([0-9]+(?:\.[0-9]+)?)\s*(gb|mb|bytes|分钟|分|秒|s|m|天|d|px|像素|tokens|条)?$/i)
  if (!match) return Number.NaN
  const suffix = match[2]?.toLowerCase() ?? ''
  const multipliers: Record<string, number> = { '': 1 }
  if (unit === 'bytes') Object.assign(multipliers, { bytes: 1, mb: 1024 ** 2, gb: 1024 ** 3 })
  if (unit === 'seconds') Object.assign(multipliers, { s: 1, 秒: 1, m: 60, 分: 60, 分钟: 60 })
  if (unit === 'minutes') Object.assign(multipliers, { m: 1, 分: 1, 分钟: 1 })
  if (unit === 'days') Object.assign(multipliers, { d: 1, 天: 1 })
  if (unit === 'pixels') Object.assign(multipliers, { px: 1, 像素: 1 })
  if (unit === 'tokens') multipliers.tokens = 1
  if (unit === 'count') multipliers.条 = 1
  if (!Object.prototype.hasOwnProperty.call(multipliers, suffix)) return Number.NaN
  const [whole, frac = ''] = match[1]!.split('.')
  const scale = 10n ** BigInt(frac.length)
  const numerator = BigInt(`${whole}${frac}`) * BigInt(multipliers[suffix]!)
  if (numerator % scale !== 0n) return Number.NaN
  const result = Number(numerator / scale)
  return Number.isSafeInteger(result) ? result : Number.NaN
}

export function formatRangeHint(row: OperatorSettingRow): string | null {
  if (row.kind !== 'quota') return null
  const hasMin = typeof row.min === 'number' && row.min > 0
  const hasMax = typeof row.max === 'number' && row.max < Number.MAX_SAFE_INTEGER
  if (hasMin && hasMax) {
    return `${formatSettingValue(row.min!, row.unit)} – ${formatSettingValue(row.max!, row.unit)}`
  }
  if (hasMin) return `≥ ${formatSettingValue(row.min!, row.unit)}`
  if (hasMax) return `≤ ${formatSettingValue(row.max!, row.unit)}`
  return null
}

export function mutationError(cause: unknown): { message: string; stale: boolean } {
  if (!(cause instanceof ApiError)) {
    return { message: '操作失败，请稍后重试', stale: false }
  }
  const body = cause.body as {
    error?: string
    details?: { rule?: string; min?: number; max?: number; currentRevision?: number }
  } | null
  if (body?.error === 'stale_revision') {
    return { message: '配置已被其他操作更新，请刷新后重试。', stale: true }
  }
  if (body?.error === 'dependency_or_derived_rejected') {
    return { message: `保存会违反规则：${body.details?.rule ?? '依赖或派生校验'}`, stale: false }
  }
  if (body?.error === 'value_out_of_range') {
    const { min, max } = body.details ?? {}
    return { message: `数值超出允许范围（${min ?? '—'} 至 ${max ?? '—'}）`, stale: false }
  }
  if (body?.error === 'boot_time_only' || body?.error === 'read_only') {
    return { message: '该配置只能通过发布或只读查看，不能在线修改。', stale: false }
  }
  return { message: '操作失败，请稍后重试', stale: false }
}
