# Gemini Provider + 内置 Profile Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 gpt-image-playground 中新增 `'gemini'` 内建服务商（走 Google v1beta `generateContent` 原生协议）并引入「内置 Profile」机制：一组从代码常量或 `VITE_BUILTIN_PROFILES` 环境变量注入的只读 ApiProfile，永远出现在 Profile 列表顶部，不进 localStorage 持久化。

**Architecture:**
- 第三个内建 provider 与 `falAiImageApi.ts` 同构，独立文件 `src/lib/geminiImageApi.ts`，纯函数 `buildGeminiRequestBody` + `parseGeminiResponse` 用 vitest TDD；调度入口 `src/lib/api.ts` 按 `profile.provider` 分发
- 内置 Profile 通过 `src/lib/builtinProfiles.ts` 暴露 `BUILTIN_PROFILES: ApiProfile[]`（默认空数组，env 优先），`normalizeSettings` 在合并阶段把内置列表注入到 `profiles` 顶部；`getPersistedState` 写回前用 `stripBuiltinProfiles` 过滤；id 强制以 `builtin-` 前缀标识，`isBuiltinProfile()` 工具函数用于 UI readonly 判定

**Tech Stack:** TypeScript 5.8 + React 19 + Vite 6 + Vitest 4 + Zustand 5（与现状一致）

**Spec reference:** `docs/superpowers/specs/2026-05-12-gemini-provider-design.md`

**File map:**
- 新增 `src/lib/builtinProfiles.ts` + `src/lib/builtinProfiles.test.ts`
- 新增 `src/lib/geminiImageApi.ts` + `src/lib/geminiImageApi.test.ts`
- 修改 `src/types.ts`（`BuiltInApiProvider` 加 `'gemini'`）
- 修改 `src/lib/apiProfiles.ts`（Gemini 常量/默认值、`switchApiProfileProvider`、`normalizeApiProfile`、`getApiProviderLabel`、`validateApiProfile`、`isBuiltinProfile`、注入合并）
- 修改 `src/lib/apiProfiles.test.ts`（补 gemini / 内置 profile 用例）
- 修改 `src/lib/api.ts`（gemini 分支分发）
- 修改 `src/store.ts`（`getPersistedState` 剥离内置 profile；`store.test.ts` 补 round-trip）
- 修改 `src/components/SettingsModal.tsx`（provider 下拉 + 内置徽章 + readonly + 复制）
- 修改 `src/components/InputBar.tsx`（gemini 时隐藏不支持控件、禁用 mask）
- 修改 `src/components/DetailModal.tsx`（gemini 任务参数显示精简，可选）

---

## Task 1: types.ts 加入 `'gemini'` 作为内建 provider

**Files:**
- Modify: `src/types.ts:4`

- [ ] **Step 1: 修改 BuiltInApiProvider 联合类型**

把第 4 行改为：

```ts
export type BuiltInApiProvider = 'openai' | 'fal' | 'gemini'
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc -b`
Expected: 报多个文件类型错（`apiProfiles.ts`、`SettingsModal.tsx` 等 switch/分支未覆盖 `'gemini'`）。**留着这些错误**，后续 Task 修复。

- [ ] **Step 3: 提交**

```bash
git add src/types.ts
git commit -m "feat(types): add 'gemini' to BuiltInApiProvider union"
```

---

## Task 2: apiProfiles.ts 加 Gemini 常量与 default profile 构造器

**Files:**
- Modify: `src/lib/apiProfiles.ts:17-26` (常量) 与文件末尾（导出新函数）
- Test: `src/lib/apiProfiles.test.ts`

- [ ] **Step 1: 写失败测试**

在 `src/lib/apiProfiles.test.ts` 文件末尾追加：

```ts
import {
  createDefaultGeminiProfile,
  DEFAULT_GEMINI_BASE_URL,
  DEFAULT_GEMINI_MODEL,
} from './apiProfiles'

describe('createDefaultGeminiProfile', () => {
  it('returns a gemini profile with Google v1beta defaults', () => {
    const profile = createDefaultGeminiProfile()
    expect(profile.provider).toBe('gemini')
    expect(profile.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta')
    expect(profile.model).toBe('gemini-3.1-flash-image')
    expect(profile.apiMode).toBe('images')
    expect(profile.codexCli).toBe(false)
    expect(profile.apiProxy).toBe(false)
    expect(DEFAULT_GEMINI_BASE_URL).toBe('https://generativelanguage.googleapis.com/v1beta')
    expect(DEFAULT_GEMINI_MODEL).toBe('gemini-3.1-flash-image')
  })

  it('applies overrides', () => {
    const profile = createDefaultGeminiProfile({ name: 'My Gemini', apiKey: 'k', model: 'gemini-x' })
    expect(profile.name).toBe('My Gemini')
    expect(profile.apiKey).toBe('k')
    expect(profile.model).toBe('gemini-x')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/lib/apiProfiles.test.ts`
Expected: 测试报 `createDefaultGeminiProfile is not exported`（或类似导入错误）

- [ ] **Step 3: 实现常量与函数**

在 `src/lib/apiProfiles.ts` 顶部常量区（第 22 行附近 `DEFAULT_FAL_MODEL` 之后）追加：

```ts
export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-image'
```

更新 `BUILT_IN_PROVIDER_IDS`：

```ts
const BUILT_IN_PROVIDER_IDS = new Set<ApiProvider>(['openai', 'fal', 'gemini'])
```

在 `createDefaultFalProfile` 之后追加：

```ts
export function createDefaultGeminiProfile(overrides: Partial<ApiProfile> = {}): ApiProfile {
  return {
    id: `gemini-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: '新配置',
    provider: 'gemini',
    baseUrl: DEFAULT_GEMINI_BASE_URL,
    apiKey: '',
    model: DEFAULT_GEMINI_MODEL,
    timeout: DEFAULT_API_TIMEOUT,
    apiMode: 'images',
    codexCli: false,
    apiProxy: false,
    ...overrides,
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/lib/apiProfiles.test.ts`
Expected: 两个 `createDefaultGeminiProfile` 用例 PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/apiProfiles.ts src/lib/apiProfiles.test.ts
git commit -m "feat(profiles): add Gemini provider defaults and factory"
```

---

## Task 3: apiProfiles.ts 让 normalizeApiProfile/getApiProviderLabel/validateApiProfile 识别 gemini

**Files:**
- Modify: `src/lib/apiProfiles.ts`（多处分支扩展）
- Test: `src/lib/apiProfiles.test.ts`

- [ ] **Step 1: 写失败测试**

在 `apiProfiles.test.ts` 追加：

```ts
import {
  getApiProviderLabel,
  normalizeApiProfile,
  validateApiProfile,
  DEFAULT_SETTINGS,
} from './apiProfiles'

describe('gemini provider integration', () => {
  it('normalizeApiProfile accepts provider: gemini', () => {
    const profile = normalizeApiProfile({
      id: 'g1',
      name: 'G',
      provider: 'gemini',
      baseUrl: 'https://example.com/v1beta',
      apiKey: 'k',
      model: 'gemini-3.1-flash-image',
      timeout: 600,
      apiMode: 'images',
    })
    expect(profile.provider).toBe('gemini')
    expect(profile.baseUrl).toBe('https://example.com/v1beta')
    expect(profile.model).toBe('gemini-3.1-flash-image')
  })

  it('getApiProviderLabel returns Gemini', () => {
    expect(getApiProviderLabel(DEFAULT_SETTINGS, 'gemini')).toBe('Gemini')
  })

  it('validateApiProfile requires baseUrl for gemini', () => {
    const profile = createDefaultGeminiProfile({ baseUrl: '', apiKey: 'k' })
    expect(validateApiProfile(profile)).toMatch(/API URL/)
  })

  it('validateApiProfile passes for a complete gemini profile', () => {
    const profile = createDefaultGeminiProfile({ apiKey: 'k' })
    expect(validateApiProfile(profile)).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/lib/apiProfiles.test.ts`
Expected: `normalizeApiProfile` 用例失败（provider 被强制为 'openai'）、label 用例失败

- [ ] **Step 3: 修改 normalizeApiProfile**

定位到 `normalizeApiProfile` 函数（约第 376 行）。把 `provider` 判定与 defaults 选择改为：

```ts
const rawProvider = typeof record.provider === 'string' ? record.provider : ''
const provider: ApiProvider =
  rawProvider === 'fal' || rawProvider === 'gemini' || customProviderIds.has(rawProvider)
    ? rawProvider
    : 'openai'
const defaults = provider === 'fal'
  ? createDefaultFalProfile(fallback)
  : provider === 'gemini'
    ? createDefaultGeminiProfile(fallback)
    : createDefaultOpenAIProfile(fallback)
```

把同函数里的 baseUrl 规整（约 389 行）扩展：

```ts
baseUrl: provider === 'fal'
  ? rawBaseUrl.trim().replace(/\/+$/, '') || DEFAULT_FAL_BASE_URL
  : provider === 'gemini'
    ? rawBaseUrl.trim().replace(/\/+$/, '') || DEFAULT_GEMINI_BASE_URL
    : rawBaseUrl,
```

- [ ] **Step 4: 修改 getApiProviderLabel**

定位到 `getApiProviderLabel` 函数（约第 461 行），在 fal 分支后追加：

```ts
if (provider === 'gemini') return 'Gemini'
```

- [ ] **Step 5: 修改 validateApiProfile**

定位到 `validateApiProfile`（约第 548 行）。当前逻辑：`profile.provider !== 'fal'` 时要求 baseUrl。`gemini` 同样需要 baseUrl，所以无需改逻辑，但确认行为：将测试中验证 gemini 缺 baseUrl 必须报错的预期与实现对齐。代码无需修改。

- [ ] **Step 6: 修改 normalizeProviderDraft**

定位到 `normalizeProviderDraft` 函数（约第 346 行），把：

```ts
const knownProvider = provider === 'fal' || provider === 'openai' || customProviderIds.has(provider)
```

改为：

```ts
const knownProvider = provider === 'fal' || provider === 'openai' || provider === 'gemini' || customProviderIds.has(provider)
```

并把 fallback 选择：

```ts
const fallback = provider === 'fal' ? createDefaultFalProfile() : createDefaultOpenAIProfile()
```

改为：

```ts
const fallback = provider === 'fal'
  ? createDefaultFalProfile()
  : provider === 'gemini'
    ? createDefaultGeminiProfile()
    : createDefaultOpenAIProfile()
```

把 draft 的 baseUrl 规整段（fal 强制 trim/+ default）：

```ts
return {
  baseUrl: provider === 'fal'
    ? baseUrl?.trim().replace(/\/+$/, '') || DEFAULT_FAL_BASE_URL
    : baseUrl,
  ...
}
```

改为：

```ts
return {
  baseUrl: provider === 'fal'
    ? baseUrl?.trim().replace(/\/+$/, '') || DEFAULT_FAL_BASE_URL
    : provider === 'gemini'
      ? baseUrl?.trim().replace(/\/+$/, '') || DEFAULT_GEMINI_BASE_URL
      : baseUrl,
  ...
}
```

- [ ] **Step 7: 跑测试确认通过**

Run: `npm test -- src/lib/apiProfiles.test.ts`
Expected: 4 个新测试 PASS；原有测试也 PASS

- [ ] **Step 8: 提交**

```bash
git add src/lib/apiProfiles.ts src/lib/apiProfiles.test.ts
git commit -m "feat(profiles): recognize gemini in normalize/validate/label"
```

---

## Task 4: apiProfiles.ts 扩展 switchApiProfileProvider 处理 gemini

**Files:**
- Modify: `src/lib/apiProfiles.ts:290-344`
- Test: `src/lib/apiProfiles.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { switchApiProfileProvider } from './apiProfiles'

describe('switchApiProfileProvider gemini branch', () => {
  it('switches openai → gemini using gemini defaults', () => {
    const base = createDefaultOpenAIProfile({ apiKey: 'sk-abc', baseUrl: 'https://api.openai.com/v1' })
    const next = switchApiProfileProvider(base, 'gemini')
    expect(next.provider).toBe('gemini')
    expect(next.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta')
    expect(next.model).toBe('gemini-3.1-flash-image')
    expect(next.apiMode).toBe('images')
    expect(next.codexCli).toBe(false)
    expect(next.apiProxy).toBe(false)
    expect(next.apiKey).toBe('sk-abc')
  })

  it('round-trips drafts: openai → gemini → openai retains openai baseUrl', () => {
    const base = createDefaultOpenAIProfile({ baseUrl: 'https://x.example/v1', model: 'gpt-image-2', apiKey: 'k' })
    const gem = switchApiProfileProvider(base, 'gemini')
    const back = switchApiProfileProvider(gem, 'openai')
    expect(back.baseUrl).toBe('https://x.example/v1')
    expect(back.model).toBe('gpt-image-2')
  })
})
```

(Note: `createDefaultOpenAIProfile` 已在文件顶部 import。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/lib/apiProfiles.test.ts`
Expected: 两个新用例失败（gemini 分支不存在，会回落到 default 分支但用错默认值）

- [ ] **Step 3: 实现 gemini 分支**

在 `switchApiProfileProvider` 函数中（fal 分支之后、custom-provider 分支之前），追加：

```ts
if (provider === 'gemini') {
  return {
    ...profile,
    provider,
    baseUrl: savedDraft?.baseUrl ?? DEFAULT_GEMINI_BASE_URL,
    model: savedDraft?.model ?? DEFAULT_GEMINI_MODEL,
    apiMode: 'images',
    codexCli: false,
    apiProxy: false,
    responseFormatB64Json: undefined,
    providerDrafts,
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/lib/apiProfiles.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/apiProfiles.ts src/lib/apiProfiles.test.ts
git commit -m "feat(profiles): switchApiProfileProvider supports gemini branch"
```

---

## Task 5: apiProfiles.ts 加 isBuiltinProfile 工具

**Files:**
- Modify: `src/lib/apiProfiles.ts`（导出新常量与函数）
- Test: `src/lib/apiProfiles.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { isBuiltinProfile, BUILTIN_PROFILE_ID_PREFIX } from './apiProfiles'

describe('isBuiltinProfile', () => {
  it('returns true for ids starting with builtin-', () => {
    expect(isBuiltinProfile({ id: 'builtin-gemini-flash' } as any)).toBe(true)
    expect(BUILTIN_PROFILE_ID_PREFIX).toBe('builtin-')
  })
  it('returns false for user profile ids', () => {
    expect(isBuiltinProfile({ id: 'default-openai' } as any)).toBe(false)
    expect(isBuiltinProfile({ id: 'gemini-abc123' } as any)).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/lib/apiProfiles.test.ts`
Expected: `isBuiltinProfile is not exported`

- [ ] **Step 3: 实现**

在 `apiProfiles.ts` 顶部常量区追加：

```ts
export const BUILTIN_PROFILE_ID_PREFIX = 'builtin-'

export function isBuiltinProfile(profile: { id?: string } | null | undefined): boolean {
  return Boolean(profile?.id?.startsWith(BUILTIN_PROFILE_ID_PREFIX))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/lib/apiProfiles.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/apiProfiles.ts src/lib/apiProfiles.test.ts
git commit -m "feat(profiles): add isBuiltinProfile predicate"
```

---

## Task 6: builtinProfiles.ts 模块（env 读取 + 兜底常量）

**Files:**
- Create: `src/lib/builtinProfiles.ts`
- Create: `src/lib/builtinProfiles.test.ts`

- [ ] **Step 1: 写失败测试**

`src/lib/builtinProfiles.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { parseBuiltinProfiles } from './builtinProfiles'

describe('parseBuiltinProfiles', () => {
  it('returns empty array for undefined / empty / invalid JSON', () => {
    expect(parseBuiltinProfiles(undefined)).toEqual([])
    expect(parseBuiltinProfiles('')).toEqual([])
    expect(parseBuiltinProfiles('not-json')).toEqual([])
    expect(parseBuiltinProfiles('{}')).toEqual([])
  })

  it('parses an array of profile-like objects with builtin- id prefix enforced', () => {
    const json = JSON.stringify([
      { id: 'gemini-flash', name: 'Flash', provider: 'gemini', baseUrl: 'https://x/v1beta', apiKey: 'k', model: 'gemini-3.1-flash-image' },
      { id: 'builtin-gemini-pro', name: 'Pro', provider: 'gemini', baseUrl: 'https://x/v1beta', apiKey: 'k', model: 'gemini-3-pro-preview' },
    ])
    const profiles = parseBuiltinProfiles(json)
    expect(profiles).toHaveLength(2)
    expect(profiles[0].id).toBe('builtin-gemini-flash')
    expect(profiles[1].id).toBe('builtin-gemini-pro')
    expect(profiles[0].provider).toBe('gemini')
  })

  it('skips entries that fail normalizeApiProfile (no provider)', () => {
    const json = JSON.stringify([{ name: 'invalid' }])
    expect(parseBuiltinProfiles(json)).toHaveLength(1)
    // normalizeApiProfile 给 fallback：provider='openai'，id 自动加前缀
    expect(parseBuiltinProfiles(json)[0].id.startsWith('builtin-')).toBe(true)
  })

  it('deduplicates by id', () => {
    const json = JSON.stringify([
      { id: 'a', name: 'A', provider: 'gemini', baseUrl: 'https://x', apiKey: 'k', model: 'm' },
      { id: 'a', name: 'A2', provider: 'gemini', baseUrl: 'https://x', apiKey: 'k', model: 'm' },
    ])
    expect(parseBuiltinProfiles(json)).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/lib/builtinProfiles.test.ts`
Expected: `Cannot find module './builtinProfiles'`

- [ ] **Step 3: 实现 builtinProfiles.ts**

```ts
import type { ApiProfile } from '../types'
import { BUILTIN_PROFILE_ID_PREFIX, normalizeApiProfile } from './apiProfiles'

function ensureBuiltinId(rawId: unknown, fallbackBase: string, used: Set<string>): string {
  const base = typeof rawId === 'string' && rawId.trim() ? rawId.trim() : fallbackBase
  const prefixed = base.startsWith(BUILTIN_PROFILE_ID_PREFIX) ? base : `${BUILTIN_PROFILE_ID_PREFIX}${base}`
  let id = prefixed
  let n = 2
  while (used.has(id)) {
    id = `${prefixed}-${n}`
    n += 1
  }
  used.add(id)
  return id
}

export function parseBuiltinProfiles(raw: string | undefined | null): ApiProfile[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const used = new Set<string>()
  const profiles: ApiProfile[] = []
  for (let i = 0; i < parsed.length; i += 1) {
    const item = parsed[i]
    if (!item || typeof item !== 'object') continue
    const normalized = normalizeApiProfile(item)
    const id = ensureBuiltinId((item as Record<string, unknown>).id, `entry-${i}`, used)
    profiles.push({ ...normalized, id })
  }
  return profiles
}

function readEnvJson(): string | undefined {
  const value = (import.meta.env as Record<string, unknown> | undefined)?.VITE_BUILTIN_PROFILES
  return typeof value === 'string' ? value : undefined
}

export const BUILTIN_PROFILES: ApiProfile[] = parseBuiltinProfiles(readEnvJson())
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/lib/builtinProfiles.test.ts`
Expected: 4 个用例全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/builtinProfiles.ts src/lib/builtinProfiles.test.ts
git commit -m "feat(profiles): introduce BUILTIN_PROFILES via VITE_BUILTIN_PROFILES env"
```

---

## Task 7: normalizeSettings 注入内置 profile + 持久化前剥离

**Files:**
- Modify: `src/lib/apiProfiles.ts:414-454`（`normalizeSettings`）
- Modify: `src/store.ts:309-325`（`getPersistedState`）
- Test: `src/lib/apiProfiles.test.ts`、`src/store.test.ts`

- [ ] **Step 1: 写失败测试（apiProfiles）**

```ts
import { normalizeSettings } from './apiProfiles'
import { BUILTIN_PROFILES, parseBuiltinProfiles } from './builtinProfiles'

describe('normalizeSettings + builtin profiles', () => {
  it('injects builtin profiles to the top of profiles list', () => {
    const builtins = parseBuiltinProfiles(JSON.stringify([
      { id: 'gemini-flash', name: 'Flash', provider: 'gemini', baseUrl: 'https://x/v1beta', apiKey: 'k', model: 'gemini-3.1-flash-image' },
    ]))
    const settings = normalizeSettings({ profiles: [], activeProfileId: '' }, { builtinProfiles: builtins })
    expect(settings.profiles[0].id).toBe('builtin-gemini-flash')
  })

  it('does not duplicate builtin profile when called twice', () => {
    const builtins = parseBuiltinProfiles(JSON.stringify([
      { id: 'gemini-flash', name: 'Flash', provider: 'gemini', baseUrl: 'https://x/v1beta', apiKey: 'k', model: 'gemini-3.1-flash-image' },
    ]))
    const once = normalizeSettings({ profiles: [], activeProfileId: '' }, { builtinProfiles: builtins })
    const twice = normalizeSettings(once, { builtinProfiles: builtins })
    expect(twice.profiles.filter((p) => p.id === 'builtin-gemini-flash')).toHaveLength(1)
  })

  it('uses BUILTIN_PROFILES when options omitted', () => {
    const settings = normalizeSettings({ profiles: [], activeProfileId: '' })
    const builtinIds = settings.profiles.filter((p) => p.id.startsWith('builtin-')).map((p) => p.id)
    expect(builtinIds).toEqual(BUILTIN_PROFILES.map((p) => p.id))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/lib/apiProfiles.test.ts`
Expected: `normalizeSettings` 不接受第二个参数；前两个用例失败

- [ ] **Step 3: 修改 normalizeSettings 签名与实现**

在 `apiProfiles.ts` 文件顶部加 import：

```ts
import { BUILTIN_PROFILES } from './builtinProfiles'
```

把 `normalizeSettings` 改成接受可选第二参数：

```ts
export interface NormalizeSettingsOptions {
  builtinProfiles?: ApiProfile[]
}

export function normalizeSettings(input: Partial<AppSettings> | unknown, options: NormalizeSettingsOptions = {}): AppSettings {
  const builtins = options.builtinProfiles ?? BUILTIN_PROFILES
  // ... 原有逻辑保留到 profiles 构建为止 ...
}
```

在原函数构建 `profiles` 数组之后、`activeProfileId` 计算之前，插入：

```ts
const builtinIds = new Set(builtins.map((p) => p.id))
const userProfiles = profiles.filter((p) => !builtinIds.has(p.id))
const profilesWithBuiltins = [...builtins, ...userProfiles]
```

然后把后续 `profiles` 引用改为 `profilesWithBuiltins`。注意 `activeProfileId` 解析时也要从合并列表里查：

```ts
const activeProfileId = typeof record.activeProfileId === 'string' && profilesWithBuiltins.some((p) => p.id === record.activeProfileId)
  ? record.activeProfileId
  : profilesWithBuiltins[0].id
const active = profilesWithBuiltins.find((p) => p.id === activeProfileId) ?? profilesWithBuiltins[0]
```

返回对象中 `profiles: profilesWithBuiltins`。

**注意循环导入**：`apiProfiles.ts` 当前导入 `builtinProfiles.ts`，而 `builtinProfiles.ts` 又导入 `apiProfiles.ts`。这是双向但允许的（用的是函数和常量，不在 module top level 互调）。如 vitest 报错，把 `BUILTIN_PROFILES` 改为按需读取：

```ts
function defaultBuiltinProfiles(): ApiProfile[] {
  return BUILTIN_PROFILES
}
```

并在 `normalizeSettings` 内调用。

- [ ] **Step 4: 跑测试确认 apiProfiles 通过**

Run: `npm test -- src/lib/apiProfiles.test.ts`
Expected: 3 个新用例 PASS

- [ ] **Step 5: 写 store.ts 失败测试**

在 `src/store.test.ts` 文件末尾追加（如文件已经存在；如不存在则创建相同结构）：

```ts
import { describe, expect, it } from 'vitest'
import { getPersistedState } from './store'
import type { AppState } from './store'

describe('getPersistedState builtin profile stripping', () => {
  it('removes builtin profiles before persisting', () => {
    const state = {
      settings: {
        ...DEFAULT_SETTINGS,
        profiles: [
          { ...createDefaultOpenAIProfile(), id: 'builtin-x', provider: 'gemini' as const },
          createDefaultOpenAIProfile({ id: 'user-profile' }),
        ],
      },
      // ... 其它 AppState 必需字段填充
    } as unknown as AppState
    const persisted = getPersistedState(state)
    expect(persisted.settings.profiles.find((p) => p.id === 'builtin-x')).toBeUndefined()
    expect(persisted.settings.profiles.find((p) => p.id === 'user-profile')).toBeDefined()
  })
})
```

`store.test.ts` 已有时，复用其测试基础设施（查看现有文件了解 `AppState` mock 模式）。如果当前 `getPersistedState` 不导出，需要将其 export（已经是 export，见 `src/store.ts:309`）。

- [ ] **Step 6: 跑测试确认失败**

Run: `npm test -- src/store.test.ts`
Expected: builtin profile 仍出现在 persisted.profiles 中

- [ ] **Step 7: 修改 getPersistedState**

在 `src/store.ts:309` 的 `getPersistedState` 中，把：

```ts
export function getPersistedState(state: AppState) {
  const settings = normalizeSettings(state.settings)
  return {
    settings,
    ...
  }
}
```

改为：

```ts
import { isBuiltinProfile } from './lib/apiProfiles'

export function getPersistedState(state: AppState) {
  const normalized = normalizeSettings(state.settings)
  const settings = {
    ...normalized,
    profiles: normalized.profiles.filter((p) => !isBuiltinProfile(p)),
  }
  return {
    settings,
    ...
  }
}
```

(`isBuiltinProfile` 可能已在 import 列表中；若否，加进顶部 import。)

- [ ] **Step 8: 跑测试确认通过**

Run: `npm test`
Expected: 全部 PASS

- [ ] **Step 9: 提交**

```bash
git add src/lib/apiProfiles.ts src/lib/apiProfiles.test.ts src/store.ts src/store.test.ts
git commit -m "feat(profiles): inject builtin profiles at top, strip on persist"
```

---

## Task 8: api.ts 分发到 gemini

**Files:**
- Modify: `src/lib/api.ts`

- [ ] **Step 1: 修改 callImageApi**

```ts
import { getActiveApiProfile, getCustomProviderDefinition } from './apiProfiles'
import { callFalAiImageApi } from './falAiImageApi'
import { callGeminiImageApi } from './geminiImageApi'
import { callOpenAICompatibleImageApi } from './openaiCompatibleImageApi'
import type { CallApiOptions, CallApiResult } from './imageApiShared'

export type { CallApiOptions, CallApiResult } from './imageApiShared'
export { normalizeBaseUrl } from './devProxy'

export async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  const profile = getActiveApiProfile(opts.settings)
  if (profile.provider === 'fal') return callFalAiImageApi(opts, profile)
  if (profile.provider === 'gemini') return callGeminiImageApi(opts, profile)

  return callOpenAICompatibleImageApi(opts, profile, getCustomProviderDefinition(opts.settings, profile.provider))
}
```

- [ ] **Step 2: 此时还没有 geminiImageApi.ts，typecheck 会报错。先不提交，留到 Task 11**

跳过提交。

---

## Task 9: geminiImageApi.ts — buildGeminiRequestBody 纯函数

**Files:**
- Create: `src/lib/geminiImageApi.ts`
- Create: `src/lib/geminiImageApi.test.ts`

- [ ] **Step 1: 写失败测试**

`src/lib/geminiImageApi.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { buildGeminiRequestBody } from './geminiImageApi'

describe('buildGeminiRequestBody', () => {
  it('builds text-only request', () => {
    const body = buildGeminiRequestBody({
      prompt: 'a cat',
      inputImageDataUrls: [],
      params: { ...DEFAULT_PARAMS, size: 'auto', n: 1 },
    })
    expect(body.contents[0].parts).toEqual([{ text: 'a cat' }])
    expect(body.generationConfig?.imageConfig).toBeUndefined()
    expect(body.generationConfig?.candidateCount).toBe(1)
    expect(body.generationConfig?.responseModalities).toEqual(['IMAGE'])
  })

  it('attaches inlineData parts for reference images', () => {
    const png1 = 'data:image/png;base64,AAA'
    const png2 = 'data:image/jpeg;base64,BBB'
    const body = buildGeminiRequestBody({
      prompt: 'edit it',
      inputImageDataUrls: [png1, png2],
      params: { ...DEFAULT_PARAMS, size: 'auto', n: 1 },
    })
    expect(body.contents[0].parts).toEqual([
      { text: 'edit it' },
      { inlineData: { mimeType: 'image/png', data: 'AAA' } },
      { inlineData: { mimeType: 'image/jpeg', data: 'BBB' } },
    ])
  })

  it('maps size to nearest aspectRatio (1024x1024 → 1:1)', () => {
    const body = buildGeminiRequestBody({
      prompt: 'p',
      inputImageDataUrls: [],
      params: { ...DEFAULT_PARAMS, size: '1024x1024' },
    })
    expect(body.generationConfig?.imageConfig).toEqual({ aspectRatio: '1:1' })
  })

  it('maps 1536x1024 (ratio 1.5) to 4:3 (closest of {1, 16/9, 9/16, 4/3, 3/4})', () => {
    const body = buildGeminiRequestBody({
      prompt: 'p',
      inputImageDataUrls: [],
      params: { ...DEFAULT_PARAMS, size: '1536x1024' },
    })
    expect(body.generationConfig?.imageConfig).toEqual({ aspectRatio: '4:3' })
  })

  it('maps 1920x1080 (16:9) to 16:9', () => {
    const body = buildGeminiRequestBody({
      prompt: 'p',
      inputImageDataUrls: [],
      params: { ...DEFAULT_PARAMS, size: '1920x1080' },
    })
    expect(body.generationConfig?.imageConfig).toEqual({ aspectRatio: '16:9' })
  })

  it('passes candidateCount from params.n', () => {
    const body = buildGeminiRequestBody({
      prompt: 'p',
      inputImageDataUrls: [],
      params: { ...DEFAULT_PARAMS, size: 'auto', n: 3 },
    })
    expect(body.generationConfig?.candidateCount).toBe(3)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/lib/geminiImageApi.test.ts`
Expected: `Cannot find module './geminiImageApi'`

- [ ] **Step 3: 实现 buildGeminiRequestBody**

`src/lib/geminiImageApi.ts`：

```ts
import type { TaskParams } from '../types'

export interface GeminiPart {
  text?: string
  inlineData?: { mimeType: string; data: string }
}

export interface GeminiRequestBody {
  contents: Array<{ role: 'user'; parts: GeminiPart[] }>
  generationConfig?: {
    responseModalities?: string[]
    imageConfig?: { aspectRatio: string }
    candidateCount?: number
  }
}

const ASPECT_RATIOS: Array<{ label: string; value: number }> = [
  { label: '1:1', value: 1 },
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:4', value: 3 / 4 },
]

function nearestAspectRatio(size: string): string | undefined {
  const m = size.match(/^(\d+)x(\d+)$/i)
  if (!m) return undefined
  const w = Number(m[1])
  const h = Number(m[2])
  if (!w || !h) return undefined
  const ratio = w / h
  let best = ASPECT_RATIOS[0]
  let bestDelta = Math.abs(best.value - ratio)
  for (const candidate of ASPECT_RATIOS.slice(1)) {
    const delta = Math.abs(candidate.value - ratio)
    if (delta < bestDelta) {
      best = candidate
      bestDelta = delta
    }
  }
  return best.label
}

function dataUrlToInlinePart(dataUrl: string): GeminiPart | null {
  const m = dataUrl.match(/^data:([^;,]+);base64,(.*)$/i)
  if (!m) return null
  return { inlineData: { mimeType: m[1], data: m[2] } }
}

export function buildGeminiRequestBody(opts: {
  prompt: string
  inputImageDataUrls: string[]
  params: TaskParams
}): GeminiRequestBody {
  const parts: GeminiPart[] = [{ text: opts.prompt }]
  for (const url of opts.inputImageDataUrls) {
    const part = dataUrlToInlinePart(url)
    if (part) parts.push(part)
  }

  const generationConfig: GeminiRequestBody['generationConfig'] = {
    responseModalities: ['IMAGE'],
    candidateCount: Math.max(1, opts.params.n || 1),
  }
  const aspect = nearestAspectRatio(opts.params.size)
  if (aspect) generationConfig.imageConfig = { aspectRatio: aspect }

  return {
    contents: [{ role: 'user', parts }],
    generationConfig,
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/lib/geminiImageApi.test.ts`
Expected: 6 个用例 PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/geminiImageApi.ts src/lib/geminiImageApi.test.ts
git commit -m "feat(gemini): buildGeminiRequestBody with aspectRatio mapping"
```

---

## Task 10: geminiImageApi.ts — parseGeminiResponse 纯函数

**Files:**
- Modify: `src/lib/geminiImageApi.ts`
- Modify: `src/lib/geminiImageApi.test.ts`

- [ ] **Step 1: 写失败测试**

在 `geminiImageApi.test.ts` 追加：

```ts
import { parseGeminiResponse } from './geminiImageApi'

describe('parseGeminiResponse', () => {
  it('extracts inline image and revised prompt from one candidate', () => {
    const result = parseGeminiResponse({
      candidates: [{
        content: {
          parts: [
            { text: 'here is the cat' },
            { inlineData: { mimeType: 'image/png', data: 'AAA' } },
          ],
        },
      }],
    })
    expect(result.images).toEqual(['data:image/png;base64,AAA'])
    expect(result.revisedPrompts).toEqual(['here is the cat'])
  })

  it('extracts multiple images across candidates', () => {
    const result = parseGeminiResponse({
      candidates: [
        { content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAA' } }] } },
        { content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'BBB' } }] } },
      ],
    })
    expect(result.images).toEqual(['data:image/png;base64,AAA', 'data:image/jpeg;base64,BBB'])
  })

  it('throws when no candidates contain image parts', () => {
    expect(() => parseGeminiResponse({ candidates: [{ content: { parts: [{ text: 'no image' }] } }] }))
      .toThrow(/Gemini.*未返回可用图片/)
  })

  it('throws on empty candidates array', () => {
    expect(() => parseGeminiResponse({ candidates: [] })).toThrow(/Gemini.*未返回可用图片/)
  })

  it('attaches rawResponsePayload on parse failure', () => {
    try {
      parseGeminiResponse({ candidates: [] })
      throw new Error('should not reach here')
    } catch (err) {
      expect((err as any).rawResponsePayload).toContain('"candidates"')
    }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/lib/geminiImageApi.test.ts`
Expected: `parseGeminiResponse is not exported`

- [ ] **Step 3: 实现 parseGeminiResponse**

在 `geminiImageApi.ts` 末尾追加：

```ts
export interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] }
    finishReason?: string
  }>
}

export interface GeminiParseResult {
  images: string[]
  revisedPrompts: Array<string | undefined>
}

export function parseGeminiResponse(payload: GeminiResponse): GeminiParseResult {
  const images: string[] = []
  const revisedPrompts: Array<string | undefined> = []

  for (const candidate of payload.candidates ?? []) {
    const parts = candidate.content?.parts ?? []
    const text = parts.map((p) => (typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n').trim() || undefined
    for (const part of parts) {
      if (!part.inlineData) continue
      const { mimeType, data } = part.inlineData
      if (!mimeType || !data) continue
      images.push(`data:${mimeType};base64,${data}`)
      revisedPrompts.push(text)
    }
  }

  if (!images.length) {
    const err = new Error('Gemini 未返回可用图片数据')
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  return { images, revisedPrompts }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/lib/geminiImageApi.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/geminiImageApi.ts src/lib/geminiImageApi.test.ts
git commit -m "feat(gemini): parseGeminiResponse extracts inline images"
```

---

## Task 11: geminiImageApi.ts — callGeminiImageApi (HTTP)

**Files:**
- Modify: `src/lib/geminiImageApi.ts`
- Modify: `src/lib/geminiImageApi.test.ts`

- [ ] **Step 1: 写失败测试**

在 `geminiImageApi.test.ts` 追加：

```ts
import { afterEach, beforeEach, vi } from 'vitest'
import { callGeminiImageApi } from './geminiImageApi'
import { DEFAULT_SETTINGS, createDefaultGeminiProfile } from './apiProfiles'

describe('callGeminiImageApi', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    globalThis.fetch = fetchMock as unknown as typeof fetch
  })
  afterEach(() => {
    fetchMock.mockReset()
  })

  it('POSTs to {baseUrl}/models/{model}:generateContent with x-goog-api-key', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAA' } }] } }],
    }), { status: 200 }))

    await callGeminiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'p',
      params: { ...DEFAULT_PARAMS, size: 'auto', n: 1 },
      inputImageDataUrls: [],
    }, createDefaultGeminiProfile({ apiKey: 'gk', model: 'gemini-3.1-flash-image', baseUrl: 'https://gen.example/v1beta' }))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://gen.example/v1beta/models/gemini-3.1-flash-image:generateContent')
    expect((init as RequestInit).method).toBe('POST')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['x-goog-api-key']).toBe('gk')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('returns images array via parseGeminiResponse', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AAA' } }] } }],
    }), { status: 200 }))

    const result = await callGeminiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'p',
      params: { ...DEFAULT_PARAMS, n: 1 },
      inputImageDataUrls: [],
    }, createDefaultGeminiProfile({ apiKey: 'gk' }))

    expect(result.images).toEqual(['data:image/png;base64,AAA'])
  })

  it('rejects mask input with explicit error', async () => {
    await expect(callGeminiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'p',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: ['data:image/png;base64,AAA'],
      maskDataUrl: 'data:image/png;base64,MMM',
    }, createDefaultGeminiProfile({ apiKey: 'gk' }))).rejects.toThrow(/不支持遮罩/)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws with API error message on HTTP 400', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      error: { code: 400, message: 'Invalid argument', status: 'INVALID_ARGUMENT' },
    }), { status: 400 }))

    await expect(callGeminiImageApi({
      settings: DEFAULT_SETTINGS,
      prompt: 'p',
      params: { ...DEFAULT_PARAMS },
      inputImageDataUrls: [],
    }, createDefaultGeminiProfile({ apiKey: 'gk' }))).rejects.toThrow(/Invalid argument/)
  })
})
```

确保文件顶部已 `import { DEFAULT_PARAMS } from '../types'`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/lib/geminiImageApi.test.ts`
Expected: `callGeminiImageApi is not exported`

- [ ] **Step 3: 实现 callGeminiImageApi**

在 `geminiImageApi.ts` 末尾追加：

```ts
import type { ApiProfile } from '../types'
import {
  assertImageInputPayloadSize,
  type CallApiOptions,
  type CallApiResult,
  getApiErrorMessage,
  getDataUrlEncodedByteSize,
} from './imageApiShared'

function joinUrl(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`
}

export async function callGeminiImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  if (opts.maskDataUrl) {
    throw new Error('Gemini 服务商不支持遮罩编辑，请改用 OpenAI 或 fal.ai 服务商')
  }

  assertImageInputPayloadSize(
    opts.inputImageDataUrls.reduce((sum, url) => sum + getDataUrlEncodedByteSize(url), 0),
  )

  const body = buildGeminiRequestBody({
    prompt: opts.prompt,
    inputImageDataUrls: opts.inputImageDataUrls,
    params: opts.params,
  })

  const url = joinUrl(profile.baseUrl, `models/${encodeURIComponent(profile.model)}:generateContent`)
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': profile.apiKey,
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    throw new Error(await getApiErrorMessage(response))
  }

  const payload = (await response.json()) as GeminiResponse
  const parsed = parseGeminiResponse(payload)

  return {
    images: parsed.images,
    revisedPrompts: parsed.revisedPrompts,
    actualParamsList: parsed.images.map(() => undefined),
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/lib/geminiImageApi.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: 跑全量测试 + typecheck**

Run: `npm test && npx tsc -b`
Expected: 全部 PASS / 无 type 错误（此时 api.ts 的 callGeminiImageApi 引用已可解析）

- [ ] **Step 6: 提交**

```bash
git add src/lib/geminiImageApi.ts src/lib/geminiImageApi.test.ts src/lib/api.ts
git commit -m "feat(gemini): callGeminiImageApi over v1beta generateContent"
```

---

## Task 12: SettingsModal 加 Gemini 选项

**Files:**
- Modify: `src/components/SettingsModal.tsx`

- [ ] **Step 1: 加 Gemini 到 provider 下拉**

定位约第 338 行的 `providerSelectOptions`，把：

```ts
const providerSelectOptions = [
  { label: 'OpenAI 兼容接口', value: 'openai', draggable: true },
  { label: 'fal.ai', value: 'fal', draggable: true },
  ...
]
```

改为：

```ts
const providerSelectOptions = [
  { label: 'OpenAI 兼容接口', value: 'openai', draggable: true },
  { label: 'fal.ai', value: 'fal', draggable: true },
  { label: 'Gemini', value: 'gemini', draggable: true },
  ...
]
```

定位约第 335 行的 `defaultProviderOrder`，把：

```ts
const defaultProviderOrder = ['openai', 'fal', ...draft.customProviders.map(p => p.id)]
```

改为：

```ts
const defaultProviderOrder = ['openai', 'fal', 'gemini', ...draft.customProviders.map(p => p.id)]
```

同样在第 838 行 `handleReorderProviders`（或类似）里：

```ts
const currentOrder = draft.providerOrder || ['openai', 'fal', 'gemini', ...draft.customProviders.map(p => p.id)]
```

- [ ] **Step 2: 处理 activeProviderUsesApiUrl / activeProviderIsOpenAICompatible**

定位约第 332-333 行：

```ts
const activeProviderIsOpenAICompatible = isOpenAICompatibleProvider(draft, activeProfile.provider)
const activeProviderUsesApiUrl = activeProviderIsOpenAICompatible || activeProfile.provider === 'fal'
```

改为：

```ts
const activeProviderIsOpenAICompatible = isOpenAICompatibleProvider(draft, activeProfile.provider)
const activeProviderUsesApiUrl = activeProviderIsOpenAICompatible || activeProfile.provider === 'fal' || activeProfile.provider === 'gemini'
```

- [ ] **Step 3: 切换 provider 调用处兼容 gemini**

搜索 `switchApiProfileProvider` 在 `SettingsModal.tsx` 中的调用点（约第 857 行附近）。`switchApiProfileProvider` 已在 Task 4 中扩展，无需 UI 端改动。

但还需确认 `apiProxy` / `codexCli` toggle 在 provider==='gemini' 时被隐藏：搜索 `profile.provider === 'openai'` 在 SettingsModal 中所有使用点（grep `provider === 'openai'`），对每处保持 OpenAI 专属（不需要加 'gemini'）。

- [ ] **Step 4: 类型检查 + 测试**

Run: `npx tsc -b && npm test`
Expected: 全部 PASS / 无类型错

- [ ] **Step 5: 启动 dev server 手动验证**

Run（在另一个终端）：`npm run dev`

打开 http://localhost:5173，进入设置面板：
- 切到「Gemini」provider，看到 baseUrl=`https://generativelanguage.googleapis.com/v1beta`、model=`gemini-3.1-flash-image`
- API Key 输入框可填
- Codex CLI / 同源代理开关不显示（或显示但 disabled）

- [ ] **Step 6: 提交**

```bash
git add src/components/SettingsModal.tsx
git commit -m "feat(ui): expose Gemini as provider option in settings"
```

---

## Task 13: SettingsModal 内置 profile 徽章与 readonly

**Files:**
- Modify: `src/components/SettingsModal.tsx`

- [ ] **Step 1: 在 profile 列表项渲染处加内置徽章**

搜索 profile 列表渲染（约第 1200-1500 行某处，包含 `profile.name` 与 `onClick`）。

在 import 顶部加：

```ts
import { isBuiltinProfile } from '../lib/apiProfiles'
```

定位到列表项 JSX（每个 `ApiProfile` 渲染一个 `<li>` / `<button>` 的位置）。在显示 profile 名称的 span 旁边加：

```tsx
{isBuiltinProfile(profile) && (
  <span className="ml-2 inline-flex items-center rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
    内置
  </span>
)}
```

具体 className 按现有 SettingsModal 中已用的徽章样式（grep `bg-amber-` / `text-amber-` 等）对齐。

- [ ] **Step 2: 内置 profile 删除按钮隐藏**

定位 profile 列表项里的「删除」/「⋮」菜单（搜索 `confirmDeleteProfile` 或类似函数调用）。在该按钮渲染外层加 guard：

```tsx
{!isBuiltinProfile(profile) && (
  // 原有 删除/编辑菜单
)}
```

- [ ] **Step 3: 内置 profile 的表单字段 readonly**

定位到 profile 编辑表单（`<input value={activeProfile.baseUrl} onChange=...>` 等）。在每个 `<input>` 上加 `readOnly={isBuiltinProfile(activeProfile)}` 与 `disabled={isBuiltinProfile(activeProfile)}`，并把背景色置灰。

具体每个 input 的修改示例：

```tsx
<input
  value={activeProfile.baseUrl}
  onChange={(e) => handleUpdateActiveProfile({ baseUrl: e.target.value })}
  readOnly={isBuiltinProfile(activeProfile)}
  className={`... ${isBuiltinProfile(activeProfile) ? 'bg-zinc-100 text-zinc-500 cursor-not-allowed' : ''}`}
/>
```

对：baseUrl、apiKey、model、timeout、name、apiMode 切换器、codexCli/apiProxy toggle 全部加 readonly/disabled。

- [ ] **Step 4: 加「复制为新配置」按钮**

在编辑表单顶部或底部加：

```tsx
{isBuiltinProfile(activeProfile) && (
  <button
    type="button"
    onClick={() => handleCloneActiveProfile()}
    className="..."  // 复用已有 secondary button 样式
  >
    复制为新配置
  </button>
)}
```

在组件内实现 `handleCloneActiveProfile`：

```ts
function handleCloneActiveProfile() {
  const newId = `${activeProfile.provider}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const cloned: ApiProfile = {
    ...activeProfile,
    id: newId,
    name: `${activeProfile.name} 副本`,
  }
  updateDraft({
    profiles: [...draft.profiles, cloned],
    activeProfileId: newId,
  })
}
```

具体函数命名 / `updateDraft` 调用方式按当前文件已有的 helper（grep `setDraft` 或 `updateDraft`）对齐。

- [ ] **Step 5: 类型检查 + 测试**

Run: `npx tsc -b && npm test`
Expected: 通过

- [ ] **Step 6: 手动验证**

设置 `VITE_BUILTIN_PROFILES`（可在 `.env.local` 创建）：

```bash
echo 'VITE_BUILTIN_PROFILES=[{"id":"gemini-flash","name":"Gemini Flash Image","provider":"gemini","baseUrl":"https://generativelanguage.googleapis.com/v1beta","apiKey":"TEST_KEY","model":"gemini-3.1-flash-image","timeout":600,"apiMode":"images","codexCli":false,"apiProxy":false}]' > .env.local
```

重启 `npm run dev`，打开设置，确认：
- profile 列表顶部出现「内置 · Gemini Flash Image」（带「内置」徽章）
- 该项无删除按钮
- 表单字段灰色 readonly
- 「复制为新配置」按钮可点击，点击后切到一份可编辑副本

清理：`rm .env.local`

- [ ] **Step 7: 提交**

```bash
git add src/components/SettingsModal.tsx
git commit -m "feat(ui): show builtin profile badge, readonly form, clone action"
```

---

## Task 14: InputBar / 参数面板隐藏 Gemini 不支持的控件

**Files:**
- Modify: `src/components/InputBar.tsx`（参数控件渲染）
- Optional: `src/components/DetailModal.tsx`（参数展示精简）

- [ ] **Step 1: InputBar 加 provider 判定**

在 `InputBar.tsx` 顶部加（如未导入）：

```ts
import { getActiveApiProfile } from '../lib/apiProfiles'
```

定位渲染入口（函数顶部或返回 JSX 之前）：

```ts
const activeProfile = getActiveApiProfile(settings)
const isGemini = activeProfile.provider === 'gemini'
```

(`settings` 来源按当前文件已用 hook：`useStore((s) => s.settings)` 或 props。)

- [ ] **Step 2: mask 按钮禁用**

搜索 `MaskEditorModal` 触发按钮（约 grep `onMaskOpen` / `setMaskEditing`）。在按钮上加：

```tsx
<button
  disabled={isGemini || ...}
  title={isGemini ? '当前服务商不支持遮罩编辑' : undefined}
  ...
>
```

如使用 ViewportTooltip 组件，传 tooltip 文案。

- [ ] **Step 3: 隐藏 quality / output_format / output_compression / moderation 控件**

定位每个控件的渲染包装，加 guard：

```tsx
{!isGemini && (
  <QualitySelector ... />
)}
```

对 output_format、output_compression、moderation 同样处理。

- [ ] **Step 4: 类型检查**

Run: `npx tsc -b`
Expected: 通过

- [ ] **Step 5: 手动验证**

切到 Gemini provider，InputBar：
- mask 按钮 disabled，hover 提示「当前服务商不支持遮罩编辑」
- 不再显示 quality、output_format、output_compression、moderation 控件
- 仍显示 size、n、prompt

- [ ] **Step 6: 提交**

```bash
git add src/components/InputBar.tsx
git commit -m "feat(ui): hide unsupported controls when Gemini is active"
```

---

## Task 15: README + .env.example 文档更新

**Files:**
- Modify: `README.md`
- Create or Modify: `.env.example`

- [ ] **Step 1: 创建 / 更新 .env.example**

如不存在则创建 `.env.example`：

```
# 已有变量保留 ...
# VITE_DEFAULT_API_URL=https://api.openai.com/v1
# VITE_API_PROXY_AVAILABLE=true

# 内置 Profile（可选）：JSON 数组，列表中的 profile 将以「内置」徽章显示在 Profile 列表顶部，
# 只读不可编辑、不可删除，且不会被持久化覆盖。
# 注意：apiKey 会被打进 bundle，请仅用于受信任的部署环境。
# 示例：
# VITE_BUILTIN_PROFILES=[{"id":"gemini-flash","name":"Gemini Flash Image","provider":"gemini","baseUrl":"https://generativelanguage.googleapis.com/v1beta","apiKey":"YOUR_KEY","model":"gemini-3.1-flash-image","timeout":600,"apiMode":"images","codexCli":false,"apiProxy":false}]
```

- [ ] **Step 2: 更新 README**

在 README.md「核心特性 > 多配置与服务商增强」段落里追加一行：

```markdown
- **Gemini 原生协议**：内置 Gemini 服务商，支持通过 `v1beta/generateContent` 接口调用 `gemini-3.1-flash-image` 等图像生成模型。
- **内置 Profile（部署期注入）**：通过 `VITE_BUILTIN_PROFILES` 环境变量注入一组只读 profile，列表顶部以「内置」徽章展示。详见 `.env.example`。
```

- [ ] **Step 3: 提交**

```bash
git add README.md .env.example
git commit -m "docs: document Gemini provider and VITE_BUILTIN_PROFILES"
```

---

## Task 16: 端到端手工冒烟

**Files:** 无代码改动

- [ ] **Step 1: 全量测试 + 构建**

Run: `npm test && npm run build`
Expected: 全部 PASS / build 成功

- [ ] **Step 2: 用真实 sub2api 跑一次生图**

1. 在 `.env.local` 配置：
   ```
   VITE_BUILTIN_PROFILES=[{"id":"sub2api-flash","name":"sub2api · gemini-3.1-flash-image","provider":"gemini","baseUrl":"https://sub2api.qiliangjia.one/v1beta","apiKey":"<你的 KEY>","model":"gemini-3.1-flash-image","timeout":600,"apiMode":"images","codexCli":false,"apiProxy":false}]
   ```
2. `npm run dev`，打开页面
3. 设置面板：确认顶部出现「内置」profile，激活
4. 输入 prompt `"A simple red circle on white background, 1024x1024"`，size 选 1024x1024，n=1，提交
5. 期望：~5-15s 内出现生成图片，历史任务记录 `apiProvider='gemini'`
6. 再试一次带参考图（拖一张本地 PNG 进去）→ 编辑

- [ ] **Step 3: 边界**
- 选 size=1536x1024 提交：检查请求 body 的 aspectRatio=`4:3`（DevTools Network）
- mask 按钮 disabled（无法触发）
- 切回 OpenAI provider，原 quality/output_format 控件恢复

- [ ] **Step 4: 清理并提交 release**

清空 `.env.local` 中的 API Key 再 commit（如果需要把 .env.local 排除可加到 .gitignore；当前 .gitignore 已有 `.env.local`）。

```bash
git log --oneline | head -20
```

确认所有 Task 提交都在分支上，准备 PR。

---

## Self-Review 记录

**Spec coverage:**
- §3 决策一（独立 provider）→ Task 1, 9-11
- §3 决策二（默认 Google 官方 baseUrl）→ Task 2 `DEFAULT_GEMINI_BASE_URL`
- §3 决策三（UI 隐藏不支持控件）→ Task 14
- §3 决策四（内置 profile 编译+运行时合并、id 前缀、不持久化）→ Task 5, 6, 7, 13
- §5.1-5.3 请求/响应映射 → Task 9, 10
- §5.2 mask 拒绝 → Task 11 测试
- §5.4 candidateCount 不做兜底 → Task 9 实现按 `params.n`
- §6.1 默认值 → Task 2
- §6.2 设置面板 → Task 12
- §6.3 InputBar 控件隐藏 → Task 14
- §6.4 内置 profile UI（徽章/readonly/复制） → Task 13
- §7 数据流 → Task 8
- §8 错误处理 → Task 11 测试
- §9 测试覆盖 → Task 2-7, 9-11
- §10 兼容性 → Task 7
- §10.1 持久化剥离 → Task 7 step 7
- §11 构建顺序 → Task 1-16 序号一致

**Placeholder scan:** 无 TBD / TODO / "适当处理"。所有 code step 含完整代码块。

**Type consistency:** `createDefaultGeminiProfile`、`DEFAULT_GEMINI_BASE_URL`、`DEFAULT_GEMINI_MODEL`、`isBuiltinProfile`、`BUILTIN_PROFILE_ID_PREFIX`、`parseBuiltinProfiles`、`BUILTIN_PROFILES`、`buildGeminiRequestBody`、`parseGeminiResponse`、`callGeminiImageApi`、`GeminiRequestBody`、`GeminiResponse`、`GeminiParseResult` 跨任务命名一致。
