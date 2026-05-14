#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const CONFIG_PATH = resolve(REPO_ROOT, 'config/channels.json')
const OUTPUT_PATH = resolve(REPO_ROOT, 'src/generated/channels.public.json')

const KNOWN_KINDS = new Set(['openai-compat', 'gemini', 'http-template'])
const KNOWN_AUTH_TYPES = new Set(['bearer', 'query-key'])
const KNOWN_CAPABILITIES = new Set(['generate', 'edit', 'mask'])
// secretRef 字段误填真密钥时报错（OpenAI sk-、Google AIza 都是常见真 key 前缀）
const SUSPICIOUS_SECRET_PATTERNS = [/^sk-/i, /^AIza/, /[A-Za-z0-9_-]{30,}/]

export function buildPublicChannels(rawJson) {
  const errors = []
  const parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.channels)) {
    errors.push('config/channels.json 根节点必须是 { channels: [...] }')
    return { errors, output: null }
  }

  const seenIds = new Set()
  const publicChannels = []

  parsed.channels.forEach((channel, index) => {
    const ctx = `channels[${index}]`
    if (!channel || typeof channel !== 'object') {
      errors.push(`${ctx}: 必须是对象`)
      return
    }
    const { id, kind, label, baseUrl, auth, models, defaults, allowedPaths, disabled } = channel

    if (typeof id !== 'string' || !id.trim()) errors.push(`${ctx}.id: 缺失或不是字符串`)
    else if (!/^[a-z0-9-]+$/.test(id)) errors.push(`${ctx}.id="${id}": 必须是 kebab-case`)
    else if (seenIds.has(id)) errors.push(`${ctx}.id="${id}": 与前面记录重复`)
    seenIds.add(id)

    if (!KNOWN_KINDS.has(kind))
      errors.push(`${ctx}.kind="${kind}": 必须是 ${[...KNOWN_KINDS].join(' | ')}`)
    if (typeof label !== 'string' || !label.trim()) errors.push(`${ctx}.label: 缺失或不是字符串`)
    if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl))
      errors.push(`${ctx}.baseUrl: 必须是 http(s) URL`)

    if (!auth || typeof auth !== 'object') {
      errors.push(`${ctx}.auth: 缺失`)
    } else {
      if (!KNOWN_AUTH_TYPES.has(auth.type))
        errors.push(`${ctx}.auth.type="${auth.type}": 必须是 ${[...KNOWN_AUTH_TYPES].join(' | ')}`)
      if (typeof auth.secretRef !== 'string' || !auth.secretRef.trim()) {
        errors.push(`${ctx}.auth.secretRef: 缺失或不是字符串`)
      } else if (
        SUSPICIOUS_SECRET_PATTERNS.some((re) => re.test(auth.secretRef)) &&
        !/^[A-Z][A-Z0-9_]*$/.test(auth.secretRef)
      ) {
        errors.push(
          `${ctx}.auth.secretRef="${auth.secretRef.slice(0, 8)}...": 疑似真密钥而非环境变量名（环境变量名应为 UPPER_SNAKE_CASE）`,
        )
      }
    }

    if (!Array.isArray(models) || models.length === 0) {
      errors.push(`${ctx}.models: 缺失或为空数组`)
    } else {
      models.forEach((m, mi) => {
        const mctx = `${ctx}.models[${mi}]`
        if (!m || typeof m !== 'object') errors.push(`${mctx}: 必须是对象`)
        else {
          if (typeof m.id !== 'string' || !m.id.trim()) errors.push(`${mctx}.id: 缺失`)
          if (typeof m.label !== 'string' || !m.label.trim()) errors.push(`${mctx}.label: 缺失`)
          if (Array.isArray(m.capabilities)) {
            m.capabilities.forEach((c, ci) => {
              if (!KNOWN_CAPABILITIES.has(c))
                errors.push(
                  `${mctx}.capabilities[${ci}]="${c}": 必须是 ${[...KNOWN_CAPABILITIES].join(' | ')}`,
                )
            })
          }
        }
      })
    }

    if (!defaults || typeof defaults !== 'object') errors.push(`${ctx}.defaults: 缺失`)
    if (!Array.isArray(allowedPaths) || allowedPaths.length === 0)
      errors.push(`${ctx}.allowedPaths: 缺失或为空数组`)

    publicChannels.push({
      id,
      kind,
      label,
      models: models ?? [],
      defaults: defaults ?? {},
      ...(disabled === true ? { disabled: true } : {}),
    })
  })

  if (errors.length) return { errors, output: null }

  return {
    errors: [],
    output: { channels: publicChannels },
  }
}

function main() {
  let raw
  try {
    raw = readFileSync(CONFIG_PATH, 'utf-8')
  } catch (err) {
    console.error(`✗ 读取 ${CONFIG_PATH} 失败：${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }

  let result
  try {
    result = buildPublicChannels(raw)
  } catch (err) {
    console.error(`✗ 解析 channels.json 失败：${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }

  if (result.errors.length) {
    console.error('✗ channels.json 校验失败：')
    for (const msg of result.errors) console.error(`  - ${msg}`)
    process.exit(1)
  }

  try {
    mkdirSync(dirname(OUTPUT_PATH), { recursive: true })
    writeFileSync(OUTPUT_PATH, JSON.stringify(result.output, null, 2) + '\n', 'utf-8')
  } catch (err) {
    console.error(`✗ 写入 ${OUTPUT_PATH} 失败：${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }

  console.log(`✓ 已生成 ${OUTPUT_PATH}（共 ${result.output.channels.length} 个 channel）`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
