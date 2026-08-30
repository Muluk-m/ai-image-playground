# 一套代码，两版部署：隔离方案调研

> 研究问题：本仓库是 **MIT 开源** 项目，一套代码要同时支撑 **收费版（经营站）** 与 **非收费版（个人 / 自部署）**，
> 目前只靠 `AUTH_ENABLED` + `runtime-config.json` 一个开关区分，长期不够用。
> 追加约束：属于「我这一版」的私有运营配置（内置 channel、品牌、私有内容、密钥引用）必须放在**不提交到远程仓库**的配置文件里。
>
> 所有结论都追到一手来源（官方文档 / 规范 / RFC / 真实仓库文件）。凡是没验到的，本文明确标 `未验证`。
> 调研日期 2026-08-08。仓库事实以 `dd7ec10` 工作区为准。

---

## 0. 结论先说

**不要把「一个开关」升级成「一个 `EDITION` 枚举」。** 分成三件互不相干的事，各用各的机制：

| 关注点 | 问题 | 机制 | 产物层面 |
|---|---|---|---|
| **(i) 私有代码在不在** | 收费版独有的模块是否存在于这份产物里 | 目录 / workspace 包的**存在性**（可选 import + 构建期 overlay） | 真删 |
| **(ii) 能力是否开启** | 这个部署是否有 `accounts:login` / `channels:builtin` / `quota:daily` | `packages/shared` 里一张 **capability registry**，服务端求值 | 运行时 |
| **(iii) UI 该不该渲染** | 前端要不要画登录页 / 内置 channel 分组 | BFF 下发的**只读能力清单**（客户端可见子集） | 纯 UX |

今天 `AUTH_ENABLED` 一个 boolean 把 (i)(ii)(iii) 全占了 —— 这就是它不够用的机械原因，不是心理作用。

**私有配置的落点**：一个 gitignored 的 operator 配置文件 + `*.example` committed + env 指向外部路径。
这是 git 官方 man page 自己开的药方（见 §6.1），而且本仓库 `CHANNELS_FILE` 已经实现了一半。

**动手之前必须先修两个已存在的坑**（§7.1、§7.2），否则任何隔离设计都会被静默绕过。

---

## 1. 现状盘点（仓库事实）

| 事实 | 位置 |
|---|---|
| 唯一安全边界是 BFF 进程 env | `apps/bff/src/config.ts:28` `booleanEnv('AUTH_ENABLED', false)` |
| entrypoint 把同一个值模板化写进前端配置 | `scripts/docker-entrypoint.sh:14,38-40` |
| 前端只拿它当门禁 UX | `packages/shared/src/runtime-config.ts:26-28`（注释已写明「真正的安全边界是 BFF 自己的 AUTH_ENABLED」） |
| Dockerfile 已有 5 个 stage，且已经在用 `--target` 出第二个产物 | `Dockerfile:50` `AS admin-runtime` |
| 部署已经在用外部私有配置 | `scripts/app-compose.sh` — env 文件与 operator 配置都取自 `~/.config/ai-image-playground/`，仓库外 |
| `.gitignore` 已有 operator 覆盖文件的先例 | `.gitignore:15,17` — `apps/web/public/runtime-config.json`、`scripts/local/` |
| `CHANNELS_FILE` 已可把 channels.json 指到仓库外 | `apps/bff/src/config.ts:47` |
| channels.json 缺失时优雅降级为 BYOK-only | `apps/bff/src/routes/channels.ts` 返回 `{ channels: [] }` → 前端不渲染「内置」分组 |
| BFF **没有构建步骤**，镜像里直接跑 TS 源码 | `apps/bff/package.json` `"start": "bun run src/index.ts"`；`Dockerfile:83,99` |
| 仓库里没有 CI | `.github/workflows` 不存在 |

### `config.auth.enabled` 实际承载的四种语义

| 语义 | 调用点 |
|---|---|
| 是否要求登录 | `apps/bff/src/lib/user-auth.ts:12,25,31` |
| 任务行是否按 user 隔离 | `apps/bff/src/lib/task-access.ts:10` |
| 幂等去重的归属条件 | `apps/bff/src/routes/submit.ts:59,103` |
| 图片响应 cache-control private/public | `apps/bff/src/routes/result.ts:78` |

四件事共用一个 boolean。加第三种部署形态（比如「免费但限额」「自部署但要登录」）时，这四处会同时错。

---

## 2. 九个真实双版本项目怎么做的

全部通过读真实仓库文件核实（9/9）。

| 项目 | 布局 | 开关时机 | 一个产物还是两个 | 许可边界 |
|---|---|---|---|---|
| **PostHog** | 根 `ee/` | 运行时（可选 import） | **两个**：`posthog` + `posthog-foss`（CI `rm -rf ee/`） | 根 **MIT Expat** + `ee/LICENSE` 专有 |
| **GitLab** | 根 `ee/`、`jh/` | 两者都有：启动时判文件存在 + 运行时 feature key | **两个**（`gitlab-ce` / `gitlab-ee`） | 根 **MIT Expat** + `ee/` EE License |
| **Cal.com** | `packages/features/ee/`（真 workspace 包） | 运行时 license key | 一个 | 根 AGPLv3 + 商业 License → **2026-04 已整棵砍掉** |
| **n8n** | 文件名 `*.ee.ts` / 目录名 `*.ee/` | 运行时 `License.isLicensed()` | 一个 | 根 Sustainable Use + `LICENSE_EE.md` |
| **Bitwarden** | `bitwarden_license/src/Commercial.Core` | **编译期** `#if OSS` | **两个** | 根 AGPLv3 + Bitwarden License v1.0 |
| **Metabase** | `enterprise/backend/src/…` | 两者：`:ee` classpath alias + `defenterprise` | **两个** | AGPL / 商业，且 **LICENSE 直接写明两个 binary 的分发地址** |
| **Plausible** | `extra/lib`（不是 `ee/`） | **编译期** `on_ee` 宏 + `elixirc_paths` | **两个** | 根 AGPLv3 + `extra/COPYING.txt` 保留全部权利 |
| **Mattermost** | `einterfaces/` 接口 + `server/enterprise/` + 私有 peer 仓库 | **编译期** build tag + `init()` 注册 | **两个** | 根 + Source Available |
| **Grafana** | **公开仓库里根本没有 ee/**，只留 `pkg/extensions/.keep` 占位 | **编译期** Makefile 判文件存在 | **两个** | 只有 AGPL/Apache，**无商业条款** |

### 对 MIT 仓库最要紧的三条

**(a) MIT 根许可 + 专有子目录是成立的，而且是两个最大样本的现役配置。**
PostHog 根 LICENSE 原文：

> `* All content that resides under the "ee/" directory of this repository, if that directory exists, is licensed under the license defined in "ee/LICENSE".`
> `* Content outside of the above mentioned directories or restrictions above is available under the "MIT Expat" license as defined below.`
> — <https://raw.githubusercontent.com/PostHog/posthog/master/LICENSE>

GitLab 根 LICENSE 是同款 MIT Expat + `ee/` carve-out（<https://gitlab.com/gitlab-org/gitlab/-/raw/master/LICENSE>）。
所以 carve-out 只是在根 `LICENSE` 顶上加一段 + 子目录放一个 `LICENSE`，MIT 本身不需要改。

**(b) 但 carve-out 对前端几乎无效。** GitLab 根 LICENSE 同一段里写着：

> `* All client-side JavaScript (when served directly or after being compiled, arranged, augmented, or combined), is licensed under the "MIT Expat" license.`

Cal.com 商业 License 有同款条款（编译进客户端 JS/CSS/字体的部分回落到 AGPLv3）。
**对 `apps/web` 这种 Vite SPA，目录级许可边界保护不了任何东西 —— 真正能围起来的只有 `apps/bff`。**

**(c) Cal.com 是反面教材，而且很新。** `calcom/cal.com` 已于 2026-04-15 重命名为 `calcom/cal.diy`，
commit `ab21c7f` 删除全部 EE、AGPL-3.0 → MIT，`3893 files changed, 411020 deletions(-)`。
纯运行时 gate + 单产物的 carve-out，最后是靠截肢收场的。

### 三种可直接抄的机制

**(A) Grafana 的「提交一个空接缝」** — 公开仓库只放占位与可用默认值：

```go
// pkg/extensions/main.go 全文 140 字节
package extensions
// Imports used by Grafana enterprise are in enterprise_imports.go (behind a build tag).
var IsEnterprise bool = false
```

Makefile 判 `$(wildcard pkg/extensions/ext.go)` —— 这个文件在公开仓库里**不存在**。
<https://raw.githubusercontent.com/grafana/grafana/main/pkg/extensions/main.go>

**(B) PostHog 的「目录在不在 = 开关」** — 不是 env，是模块存在性：

```python
# posthog/settings/web.py:214-219
try:
    from ee.apps import EnterpriseConfig  # noqa: F401
except ImportError:
    pass
else:
    INSTALLED_APPS.append("ee.apps.EnterpriseConfig")
```

Bun/Elysia 的等价物就是 `await import('./private/index.ts').catch(() => null)`。
好处：**忘了设 env 不会把付费能力泄给免费版**，因为默认就是「模块不在」。

**(C) n8n 的单向 import 规则** — 九个项目里**唯一**机器强制的边界，全文约 35 行：

```ts
// packages/@n8n/eslint-config/src/rules/no-import-enterprise-edition.ts
const isEnterpriseEditionFile = filename.includes('.ee/');
if (isEnterpriseEditionFile || isIntegrationTestFile) return {};
return { ImportDeclaration(node) {
  if (node.source.value.includes('.ee/')) context.report({ node: node.source, messageId: 'noImportEnterpriseEdition' });
} };
```

不变量：**只有私有树里的代码可以 import 私有树**。没有这条，边界会在第一次「就这一次跨过去」时腐烂。
注意 n8n 自己留了口子：只检查静态 `ImportDeclaration`，动态 `import()` / `require()` 不管。
本仓库用 Biome，`未验证` Biome 能否用 `noRestrictedImports` + `overrides` 表达路径条件；表达不了就写 20 行脚本挂 turbo task。
<https://raw.githubusercontent.com/n8n-io/n8n/master/packages/%40n8n/eslint-config/src/rules/no-import-enterprise-edition.ts>

---

## 3. 构建期能不能把付费代码「真删掉」

这决定了「隔离」是真的还是自我安慰。逐机制给结论。

| 机制 | 免费产物里真删掉？ | 前提 / 代价 |
|---|---|---|
| Vite `define` **标量** + Rollup DCE | **能**，仅限被分支包住的代码 | 必须是标量、必须 `=== 'true'`、被删模块顶层不能有副作用 |
| `exports` 自定义 condition + `resolve.conditions` | **能**（bundler 根本不读那个文件） | 四份配置要同时改；必须给 `default` stub，否则免费构建直接解析失败 |
| 独立 entry（`build.rollupOptions.input`） | **能**，最干净 | 两个入口 / 两条构建命令；要盯共享 chunk 不串 |
| `pnpm --filter … deploy` | **能**，对部署目录而言 | 需 `inject-workspace-packages` 或 `--legacy`；且见下方 `.gitignore` 坑 |
| TypeScript（`customConditions` / `paths` / references） | **不能**，只做强制约束 | 便宜、值得做，但删不掉一个字节 |
| Turborepo | **不能**，而且是风险源 | 见 §7.1 |
| 今天的 BFF | **不能**，根本没有构建步骤 | 镜像里直接是 TS 源码 |

### 三个反直觉的一手事实

**① `define` 传对象永远不会常量折叠 —— 也就永远删不掉分支。**
esbuild 官方原文：

> "Replacement expressions other than arrays and objects are substituted inline, which means that they can participate in constant folding. **Array and object replacement expressions are stored in a variable and then referenced using an identifier instead of being substituted inline**, which avoids substituting repeated copies of the value but means that the values don't participate in constant folding."
> — <https://esbuild.github.io/api/#define>

Vite 6 的 `define` 就是 esbuild 的 `define`（<https://v6.vite.dev/config/shared-options.html#define>）。
所以最顺手的设计 ——「一个 `__EDITION__` 对象装所有开关」—— **DCE 收益为零**。必须是**每个开关一个标量 boolean**。
本仓库已经有一个对象 define：`apps/web/vite.config.ts:74` `__DEV_PROXY_CONFIG__`，现用法（读取而非分支）没问题，拿来当版本开关就是坑。

**② `import.meta.env.VITE_X` 永远是字符串，`"false"` 是真值。**
Vite 文档明说布尔 env 解析出来是字符串，要自己转型（<https://vite.dev/guide/env-and-mode>）。
写 `if (import.meta.env.VITE_PAID)` 会把付费代码发到**免费版**。必须 `=== 'true'`。
另外替换是拼写敏感的：`import.meta.env['X']`、解构、动态 key 都会让 DCE 失效。

**③ Rollup 默认假设每个模块都有副作用，所以「副作用 import 注册插件」这种写法删不掉。**
`treeshake.moduleSideEffects` 默认 `true`；而且：

> "**Rollup itself does not read a package's `sideEffects` field.**"
> — <https://rollupjs.org/configuration-options/#treeshake-modulesideeffects>

也就是说 `import './paid/register'`（最常见的版本插件写法）在默认配置下 **原样保留**，`define` 白设。

### 其余要点

- **Node `exports` 条件是「改选哪个文件」，不是「删文件」**；而且 key 顺序有意义、自定义条件默认被忽略：
  「Within the `"exports"` object, **key order is significant**」/「Condition strings other than … **are ignored by default**」，需 `node --conditions=x`。
  <https://nodejs.org/api/packages.html#conditional-exports>
  陷阱：把 `default` 放在自定义条件前面，付费分支就永远不可达且无报错。
- **TS `customConditions` 只影响类型检查**，且只在 `node16`/`nodenext`/`bundler` 下合法
  （<https://www.typescriptlang.org/tsconfig/#customConditions>）。本仓库 `tsconfig.base.json:5` 已是 `bundler`，可直接用。
  `paths`「does not change how import paths are emitted by `tsc`」（<https://www.typescriptlang.org/tsconfig/#paths>）。
- **Bun 侧今天无从谈起**：`apps/bff` 没有 build step。要谈「免费镜像里没有付费服务端代码」，
  先得引入 `bun build`，或者干脆在 `Dockerfile` 的 `COPY` 层面排除 —— 这是**打包问题，不是 bundler 问题**。
- **`bun build --env inline` 会把整个 `process.env` 烤进产物**（<https://bun.com/docs/bundler#env>），与私有配置约束正面冲突，禁用。

---

## 4. 能力模型：别用版本枚举，用 capability key

调研的每一个双版本产品，**没有一个**把版本枚举当 gating 原语。版本/套餐只是「映射到一组 key」的方式。

| 产品 | 单位 | 命名 | 注册表位置 |
|---|---|---|---|
| GitLab | Ruby symbol | 扁平 `:epics` `:sast` | `ee/app/models/gitlab_subscriptions/features.rb`（按套餐分组，`PLANS_BY_FEATURE` 由 `FEATURES_BY_PLAN` **推导**，只手写一个方向） |
| Metabase | 字符串 | 扁平 `:sandboxes` `:sso-saml` | token 的 `:features` 列表 + `define-premium-feature` |
| Sentry | 字符串 | `scope:name`（`organizations:sso-saml2`） | `permanent.py` / `temporary.py` |
| n8n | 字符串 | `feat:a:b` / `quota:a:b` **两个命名空间** | `LICENSE_FEATURES` / `LICENSE_QUOTAS` |
| Plausible | 模块 + atom | 每 feature 一个模块 | `@features` 列表，behaviour 编译期强制 |

**GitLab 甚至用 linter 禁止「按部署形态判断」这种写法**：

> "avoid using `Gitlab::CurrentSettings.gitlab_dedicated_instance?` directly in application code. Instead, use `Gitlab::Dedicated.feature_available?(:specific_feature)` to provide context about **why** the feature behaves differently … The `Gitlab/AvoidGitlabDedicatedInstanceChecks` RuboCop rule enforces this convention"
> — <https://docs.gitlab.com/development/ee_features/>

Metabase 在宏的 docstring 里对「不指定具体 feature」直接写警告：
「Use `:none` to always run the EE implementation … **WARNING: this is not recommended for most use cases. You probably want to gate your code by a specific premium feature.**」
（<https://raw.githubusercontent.com/metabase/metabase/master/src/metabase/premium_features/defenterprise.clj>）

### 建议形状

```ts
// packages/shared/src/capabilities.ts
export const CAPABILITIES = {
  'accounts:login':   { defaultValue: false, clientExposed: true  },
  'billing:credits':  { defaultValue: false, clientExposed: true  },
  'generation:byok':  { defaultValue: false, clientExposed: true  },
  'operator:console': { defaultValue: false, clientExposed: false },
  'quota:daily':      { defaultValue: false, clientExposed: true  },
} as const

export const QUOTAS = {
  'generation:daily-images': { defaultValue: 0 },
} as const

export type CapabilityKey = keyof typeof CAPABILITIES
export type QuotaKey = keyof typeof QUOTAS
```

设计要点，每条都有先例：

- **`scope:name` 冒号命名** —— Sentry / n8n 同款。
- **每 key 一个 `defaultValue`，一律 deny by default** —— Sentry `manager.add(..., default=…)`；
  OWASP「Deny by Default」；本仓库 `BAKED_DEFAULTS`（`runtime-config.ts:44-52`）已是这个姿势。
- **`clientExposed: boolean` 显式 opt-in 才下发给浏览器** —— Sentry 的 `api_expose` 默认 `False`，
  只有 `exposed_features` 会进序列化器；理由是官方自己写的：暴露 flag「add latency and bloat」。
- **`as const` + 派生 union type** —— n8n `BooleanLicenseFeature`、Plausible 编译期生成的 `@type t()`。
  在 TS 里这能把「拼错 key 静默返回 false」变成编译错误。
- **布尔能力和数值配额分开命名空间** —— n8n `LICENSE_FEATURES` vs `LICENSE_QUOTAS`；
  「是否限额」和「限额是多少（`DAILY_QUOTA_LIMIT = 80`）」是两件事。
- **内置 channel 可用性不进能力表** —— `/api/channels` 的列表是唯一真相源，避免能力值与
  空列表互相矛盾。
- **求值函数必须是全函数且不抛** —— 运行时未知 key 返回 `false`。配置文件缺失回落默认值；
  文件存在但损坏或 schema 无效时在启动解析阶段拒绝启动，不进入求值阶段。
- **拒绝时统一返回 HTTP 404** + `{ error: 'capability_unavailable', capability }`。
  「当前部署不存在这项能力」与自部署语义一致，不使用付费专属状态码。

### 前端那份是 UX，不是边界（有出处）

> OWASP ASVS 5.0 **V8.3.1**（L1）：「Verify that the application enforces authorization rules at a trusted service layer and doesn't rely on controls that an untrusted consumer could manipulate, such as client-side JavaScript.」
> — <https://raw.githubusercontent.com/OWASP/ASVS/master/5.0/en/0x17-V8-Authorization.md>
>
> OWASP Authorization Cheat Sheet：「Developers must never rely on client-side access control checks. While such checks **may be permissible for improving the user experience**, they should never be the decisive factor in granting or denying access to a resource.」
> — <https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html>

`runtime-config.ts:26-28` 的注释已经是对的，capability registry 只是把它从 1 个 flag 推广到 N 个。

### OpenFeature：借词汇，不引框架

规范读过了（<https://openfeature.dev/specification>，spec 仓库 `01-flag-evaluation.md` / `02-providers.md` / `glossary.md`）。
它的卖点是**运行时供应商可移植性**（`OpenFeature.setProvider`、hooks、provider 生命周期、context 调和）。
本场景没有第三方 flag 供应商、没有 per-user targeting、答案在进程启动时就定了 —— 引 SDK 是纯负担。
值得白拿的四条：字符串 flag key；**每个调用点必须带 default**（Req 1.3.1.1）；**求值不抛**（Req 1.1.7）；
启动时打一行 `reason`（`STATIC` / `DEFAULT` / `DISABLED`，Req 2.2.5），让运维分得清「配置没读到」和「配置读到了但关着」。

### 不要上签名 license 文件

RFC 7519 / RFC 8032 / Keygen 的机制都查了，结论是**今天不需要**：没有第三方付费自部署者，
operator 就是仓库作者，签发方和验证方之间没有对手。真要做时记住 Keygen 自己的告诫：
「your account ID and public key should be **hard-coded into your application code**. It should not be stored in external files or in the environment, otherwise a bad actor could swap out your keys for theirs」
（<https://keygen.sh/docs/api/cryptography/>）—— 否则「私有配置文件自己验证自己」。

---

## 5. 部署形态：一个镜像 + env / 两个镜像 / 两个仓库

| 方案 | 机制 | 有出处的代价 | 判断 |
|---|---|---|---|
| **A. 一个镜像 + env**（现状） | entrypoint 模板化 `runtime-config.json` | 符合 12-Factor：config 在 release 阶段与 build 结合，不进 build。代价是免费产物里**含有**付费代码，`AUTH_ENABLED` 是纯运行时边界，没有产物层兜底 | **保留为底座** |
| **B. 一个 Dockerfile 出两个镜像**（`--target` / bake） | `docker build --target`；`docker-bake.hcl` 的 `target`/`tags`/`inherits`/`matrix` | 增量成本近乎为零 —— 本仓库 `Dockerfile:50` 已经在用 `--target admin-runtime`。代价：各自 cache key、各自 push；bake 多文件合并时 `tags`/`target` 是**后者覆盖**（`labels`/`args` 才是合并） | **最高杠杆的一步** |
| **C. 两个分支** | 长期存活的 `paid` 分支 | 没有任何一手厂商案例支持；GitLab 评估的三个方案全是单仓库。继承两仓库的全部痛苦，还少了独立 issue tracker | **否决** |
| **D. 两个仓库** | 私有 fork | 见下方 GitLab 实测曲线 | **否决** |

### GitLab 的一手成本曲线（这是全文最有价值的证据）

> - **Pre-2016: Manual merges for each release** — 一个人在发版时合一次。
> - **2016-2017: Daily merges by a team of developers** — 提交数涨到需要 **7 个开发**每天轮流合。
> - **2017-2018: Automated merges every three hours** — 自动开 MR、@人解冲突。
> - **Present: Further automation with Merge Train** — 「the number of changes … grew to thousands of commits … The edge cases we've encountered are requiring us to invest additional time in improving the custom tool.」
>
> 分岔点原话：「Do we invest more development time in improving the custom tooling, **knowing that we will never get it 100 percent right**, or do we need to take some more drastic measures…?」
> — <https://about.gitlab.com/blog/merging-ce-and-ee-codebases/>

单次安全发布要跨两个仓库开「**around 150 merge requests**」；
**撤销**这个分裂的一次性成本是「55 different engineers submitting more than 600 merge requests … changing **nearly 1.5 million lines of code**」，
其中光是「make sure CE and EE use the same database schema」就是**两个月、约 24,000 行**。
— <https://about.gitlab.com/blog/a-single-codebase-for-gitlab-community-and-enterprise-edition/>

单人维护的仓库会**立刻**踩到「每天合并」那一级。

### 两镜像是被验证过的现实

- GitLab 安装文档同时列 `gitlab/gitlab-ee` 与 `gitlab/gitlab-ce`，切换就是一句
  「To install the Community Edition, **replace `ee` with `ce`**」（<https://docs.gitlab.com/install/docker/installation/>）。
- Mattermost 发 `mattermost-team-edition` / `mattermost-enterprise-edition`，用户侧的开关是 `.env` 里一行 `MATTERMOST_IMAGE_TAG`。
  v11 起还叠了 FIPS 变体 —— 一套代码 × 三个轴 = 4 个镜像名，**两个仓库承接不了这种乘法**。
- Metabase 的 LICENSE.txt 干脆把产物边界写进许可：
  「Binaries located at hub.docker.com/metabase/metabase-enterprise … are released under the Metabase Commercial License. Binaries located at hub.docker.com/metabase/metabase … are released under the AGPL.」

### 12-Factor 怎么说（连不利于我的部分一起引）

- 试金石正是本仓库的问题陈述：「A litmus test for whether an app has all config correctly factored out of the code is whether the codebase could be made **open source at any moment**, without compromising any credentials.」
- 对「非版本控制的配置文件」的评价不是禁止，是**有保留的肯定**：
  「This is a **huge improvement** over using constants which are checked into the code repo, **but still has weaknesses**: it's easy to mistakenly check in a config file to the repo; there is a tendency for config files to be scattered about in different places and different formats…」
  → 三个弱点都可缓解：误提交用 `.gitignore` + CI 断言；分散靠「只有一个文件」；格式绑定不适用（JSON 是语言无关的）。
- 对 `EDITION` 枚举的直接批评：「Sometimes apps batch config into named groups (often called "environments") … This method **does not scale cleanly** … resulting in a **combinatorial explosion of config** which makes managing deploys of the app very brittle.」
- build/release/run：「The **release stage** takes the build … and combines it with the deploy's current config」+「it is impossible to make changes to the code at runtime」
  → **这是反对 `--build-arg EDITION` 烤进镜像的最强论据**。
  — <https://12factor.net/config> · <https://12factor.net/build-release-run>

诚实地说：12-Factor 针对的是「部署名字组合爆炸」，而这里只有两个 SKU 且差异在**安全边界**上，不是可调参数。
但结论仍然成立：**保留正交的细粒度 flag 作为真相来源；`EDITION` 只能是一个展开成若干 capability 的 preset，不能是调用点判断的对象。**

### 数据层：一个 schema，一个文件，不要 ATTACH

GitLab 一手结论是「同一个 schema，免费版多几张空表」：

> 「gitlab-ce distribution users would get more database tables … in the gitlab-ce distribution these new tables **would not be populated, affect performance, or take significant space**. ➡️ All database migration code is open source and does not add additional maintenance burden, so **no additional work is required**.」

而且他们是花两个月**收敛**两边 schema，不是分裂它。

机械上这里也没得选：本仓库无条件开 WAL（`packages/db/src/client.ts:21`、`migrate.ts:83`），而 SQLite 明说：

> 「Transactions involving multiple attached databases are atomic, **assuming that the main database is not ":memory:" and the journal_mode is not WAL**. If … the journal_mode is WAL, then transactions continue to be atomic within each individual database file.」
> — <https://www.sqlite.org/lang_attach.html>

即：`tasks` 在主库、`daily_quota` 在付费库时，**跨库提交不是原子的**，崩溃可能只落一半。
同页还有一个静默坑：同名表未加 schema 前缀时，解析到**最近最少 attach**的那个库。

### Tier 1 静态托管（各家字段名，已核对）

- **Netlify**：`netlify.toml` 的 `[context.production]` / `[context.branch-deploy]` / `[context.deploy-preview]` 是原生的「一仓两构建」机制，
  且 `[context.*.environment]` 可带 env。但两条硬限制：`netlify.toml` 是**提交在仓库里的**，
  且「Using environment variables directly as values in your `netlify.toml` **isn't supported**」（`key = "$VAR"` 不插值）；
  官方自己说敏感值要走 UI「to avoid storing sensitive values in your repository」。另外它会**覆盖** UI 设置。
  <https://docs.netlify.com/build/configure-builds/file-based-configuration/>
- **Vercel**：`vercel.json` 的属性表里**根本没有 `env`** —— 环境变量只能走 Dashboard/CLI/API，
  一仓库对应多个 Project（数量按套餐封顶）。总量上限 64 KB/deployment，`edge` runtime 单变量 5 KB。
  <https://vercel.com/docs/monorepos> · <https://vercel.com/docs/environment-variables>
- **Cloudflare**：`[env.<name>]`，用 `--env` 或 `CLOUDFLARE_ENV` 选择（Vite 插件只认后者）。
  代价是「bindings and environment variables are **non-inheritable**, and must be specified per environment」，secrets 同理。
  <https://developers.cloudflare.com/workers/wrangler/environments/>

**结论**：Tier 1 静态部署**在结构上就装不下机密**（Vite：`VITE_*` 会被编进 bundle）。
所以收费版里带密钥的那部分，天然属于 Docker/BFF 这一层。

---

## 6. 私有 operator 配置怎么不进远程仓库

### 6.1 排名第一：`*.example` 提交 + 真名 gitignore + env 指向外部路径

**这是 git 官方 man page 自己开的药方。** `git-update-index(1)` 的 NOTES 原文：

> "Users often try to use the assume-unchanged and skip-worktree bits to tell Git to ignore changes to files that are tracked. **This does not work as expected**, since Git may still check working tree files against the index when performing certain operations. In general, Git does not provide a way to ignore changes to tracked files, so alternate solutions are recommended.
>
> For example, if the file you want to change is some sort of config file, **the repository can include a sample config file that can then be copied into the ignored name and modified.** The repository can even include a script to treat the sample file as a template, modifying and copying it automatically."
> — <https://git-scm.com/docs/git-update-index>

把这段抄进设计文档，免得半年后有人重新提议 `skip-worktree`。

配套事实：

- `.gitignore` **对已追踪文件无效**：「A `gitignore` file specifies intentionally untracked files that Git should ignore. **Files already tracked by Git are not affected**」；
  要先 `git rm --cached`。<https://git-scm.com/docs/gitignore>
  → `apps/bff/channels.json` **当前是被追踪的**，迁移需要 `git rm --cached` + 发版说明，
  同时保留 `channels.example.json` 让「数组顺序是产品契约」这条继续可见。
- `.git/info/exclude` **不会被 clone**，CI 看不到，只能当本地便利。
- `!` 否定**救不回被排除目录下的文件**：「It is not possible to re-include a file if a parent directory of that file is excluded.」
- CI 断言用 `git check-ignore -q <path>`（0 = 已忽略，1 = 没忽略）。<https://git-scm.com/docs/git-check-ignore>

本仓库已有这个约定：`apps/bff/.env.example`、`apps/web/.env.example`、`apps/admin/.env.example`、`apps/web/dev-proxy.config.example.json`。

### 6.2 排名第二：env 指向仓库外的配置路径（已实现一半）

`apps/bff/src/config.ts:47` 的 `channelsFile: env('CHANNELS_FILE', '') || null` 就是这个模式。三个一手先例：

| 产品 | 机制 |
|---|---|
| Sentry self-hosted | `SENTRY_CONF: "/etc/sentry"` + `- "./sentry:/etc/sentry"` bind mount；`sentry/config.example.yml` 提交、`sentry/config.yml` gitignore |
| Grafana | `--config /custom/config.ini` 或 `GF_PATHS_CONFIG`；值还支持 `$__file{/etc/secrets/…}` 与 `GF_<Section>_<Key>__FILE` |
| PostgreSQL | `postgres -c config_file=…`；叠加用 `include_if_exists`（文件不存在只记日志不报错） |

<https://raw.githubusercontent.com/getsentry/self-hosted/master/docker-compose.yml> ·
<https://grafana.com/docs/grafana/latest/setup-grafana/configure-grafana/> ·
<https://www.postgresql.org/docs/current/config-setting.html>

建议把它**收敛成一个** `OPERATOR_CONFIG_FILE`：内置 channel + 品牌 + 私有落地内容 + **secret 的名字**（不是值）。
真密钥继续走 env / Docker secret —— `channels.json` 现在存 `auth.secretRef` 环境变量名而非明文，这个做法是对的，保持。
合并语义抄 PostgreSQL 的 `include_if_exists`：基础配置提交，operator overlay 可选，缺失不报错。

Web 侧同理：`docker-entrypoint.sh` 现在从 env 模板化写 `dist/runtime-config.json`（Grafana 风格），
再加一句「若 `/etc/<app>/runtime-config.json` 存在则覆盖」，operator 就只改一个文件而不是十来个 env。

### 6.3 CI 怎么构建收费版产物（gitignored 文件在 CI 里不存在）

四种，按爆炸半径升序：

1. **从 GitHub Actions secret 现写出来**：整个 JSON 存成一个 secret（上限 **48 KB**），
   `printf '%s' "$OPERATOR_CONFIG" > ops/operator.json`。用 **environment secret** 可以挂部署保护规则。
   自带 fork 安全性：「With the exception of `GITHUB_TOKEN`, **secrets are not passed to the runner when a workflow is triggered from a forked repository**」——
   fork 的 CI 自然只能构建免费版。<https://docs.github.com/en/actions/reference/security/secrets>
2. **提交 SOPS 加密文件，CI 解密**。SOPS 只加密**值**、保留 key 明文，JSON 仍可 diff：
   「By default, SOPS encrypts all the values of a YAML, JSON, ENV, or INI file and **leaves the keys in cleartext**」，
   配 `--encrypted-regex '^(secret|apiKey|baseUrl)$'` 只加密敏感叶子。后端用 age（一对密钥、无基础设施）。
   代价：公开仓库里的密文是**永久**的，将来密钥泄露会追溯性暴露全部历史值。<https://getsops.io/docs/> · <https://github.com/FiloSottile/age>
3. **checkout 一个私有 overlay 仓库**：`actions/checkout` 带 `repository:` + `token: ${{ secrets.OPS_REPO_PAT }}` + `path: ops`。
   比 submodule 好，因为**公开仓库里不会出现 `.gitmodules`**，私有仓库地址不外泄，也没有 detached HEAD。
4. **压根不在公开 CI 里构建收费版**（Sentry 模型）：operator 自己机器上 `docker build .`，
   本地目录 build context **包含** gitignored 文件（只有 `.dockerignore` 会过滤）。
   注意 `docker build https://github.com/…` 这种远程 Git context 是浅克隆，文件根本不存在。
   <https://docs.docker.com/build/concepts/context/>

### 6.4 明确否决

- **`git update-index --skip-worktree` / `--assume-unchanged`**：git 官方说不管用（§6.1 原文）。
- **git-crypt**：README 自陈「does not support **revoking** access … (there's no `del-gpg-user` command…) and also symmetric key mode (there's no support for rotating the key)」，
  且密文不可压缩，公开仓库会永久膨胀。对一个准备接受外部贡献的仓库，无法吊销是致命的。<https://github.com/AGWA/git-crypt>
- **`--build-arg EDITION=paid`**：Docker 文档原文「Build arguments are visible in the `docker history` command **and in `max` mode provenance attestations**, which are attached to the image by default if you use the Buildx GitHub Actions **and your GitHub repository is public**」。
  构建期真需要密钥就用 `--mount=type=secret`（只在该条指令期间存在于 `/run/secrets/<id>`）。
  <https://docs.docker.com/reference/dockerfile/#arg> · <https://docs.docker.com/build/building/secrets/>

---

## 7. 动手前必须先修的两个坑

### 7.1 Turborepo 缓存投毒 —— 今天就存在

`turbo.json` **没有任何 `env` / `globalEnv` 声明**，`build.inputs` 是显式白名单（`turbo.json:8-16`），
里面既没有 `.env*`，也没有 `runtime-config.json` / `channels.json`。后果：

1. 任何非 `VITE_` 前缀的开关（`EDITION`、`AUTH_ENABLED`）**不进构建 hash**。
   Framework Inference 只自动覆盖 `VITE_*`。
   → `EDITION=paid turbo build` 之后 `EDITION=free turbo build` = **缓存命中，把付费产物当免费版发出去**。
2. 声明了 `inputs` 就等于**放弃了 `.gitignore` 感知**（官方：「Using the `inputs` key opts you out of `turbo`'s default behavior of considering `.gitignore`」），改私有配置不会 miss cache。
3. `envMode` 默认 `strict` **救不了**，因为本应用会优雅降级 —— 官方原话：
   > 「While Strict Mode makes it much more likely for your task to fail …, **it doesn't guarantee task failure. If your application is able to gracefully handle a missing environment variable, you could still successfully complete tasks and get unintended cache hits.**」

   而 `apps/web/src/lib/runtimeConfig.ts` 正是在 404 / JSON 损坏 / schema 不符 / 网络错误四种情况下都回落 `BAKED_DEFAULTS`。

Loose 模式的官方示例几乎就是本场景的剧本：
「You then build your application using a value for `MY_API_URL` that targets your preview environment … **see a cache hit — even though the value of the `MY_API_URL` variable has changed!**」
— <https://turborepo.com/docs/crafting-your-repository/using-environment-variables>

**修法**：所有版本开关写进 `globalEnv`（或 `build.env`），私有配置路径写进 `globalDependencies` / `inputs`，
用 `turbo run build --summarize` / `--dry=json` 核对 `environmentVariables` 字段。

### 7.2 `.dockerignore` 会把私有配置烤进公开镜像

当前 `.dockerignore` 只有 `.git`、`.DS_Store`、`**/.DS_Store`、`**/.env`、`**/.turbo`、`**/dist`、`**/node_modules`、`artifacts`、`apps/admin/artifacts`。
而 `Dockerfile:41` 是 `COPY . .`，`Dockerfile:83` 是 `COPY apps/bff ./apps/bff`。
**`.gitignore` 不等于 `.dockerignore`** —— 放在仓库根或 `apps/bff/` 下的 gitignored operator 文件会被原样打进镜像。
新增任何私有配置路径，必须同步加一行 `.dockerignore`。<https://docs.docker.com/build/concepts/context/>

### 7.3 其余需要写进设计文档的坑

- **`pnpm deploy` 会继承 `.gitignore`**：文件选择顺序是 `package.json` 的 `"files"` → `.npmignore` → `.gitignore`。
  也就是**同一条规则**既让配置不进 git，也让它悄悄不进部署产物。<https://pnpm.io/cli/deploy>
- **Bun 会在 Vite 之前自动加载 `.env`**，而 Vite「respects existing `process.env` values」，可能静默盖掉 `.env.production`。
  本仓库两个 runtime 都在用，属于活跃风险。<https://vite.dev/guide/env-and-mode>
- **编译期消除会和静态分析打架**。Plausible 为此写了 `:erlang.phash2(1, 1)` 的 hack，注释直言
  「tricks dialyzer … and also tricks elixir >1.18 type checker」。TS 的 dead-branch narrowing 会有同款摩擦。
- **「判文件存在 = 判版本」是远距离作用**。GitLab 的版本取决于 `root.join('ee/app/models/license.rb').exist?`，
  源码注释还要求「The behavior needs to be synchronised with `config/helpers/is_ee_env.js`」——
  **同一个判据在两种语言里手工维护两份**。前后端各有一个 gate 的仓库都会继承这个问题。
- **fail-open 还是 fail-closed 要逐点决定**。Metabase 在函数上逐个写 `:feature :none ;; fail CLOSED`；
  n8n 是 `?? false`（fail closed）。选错一处就是静默送出付费能力，或静默宕掉功能。
- **公开仓库的 push protection 默认是关的**。免费公开仓自动获得的是 *secret scanning* 与 **user-level** push protection；
  **repository-level** push protection「Is disabled by default」且需要付费的 GitHub Secret Protection。
  所以真正的闸门要靠本地 `gitleaks` pre-commit + CI 里的 `gitleaks dir` + `git check-ignore -q` 断言。
  <https://docs.github.com/en/code-security/concepts/secret-security/push-protection>
- **PostHog 发布派生仓库时有泄露窗口，他们专门工程化规避**：
  `foss-sync.yml` 的注释写着「Stage on a branch, not master, so master never momentarily exposes raw posthog (ee/, non-MIT LICENSE) before the FOSS cleanup commit lands.」
  朴素的 `rsync + push` 镜像会有一段时间公开仓库里含私有树。

---

## 8. 推荐落地顺序

先修坑，再谈隔离。每步都能独立提交。

1. **修 §7.1**：`turbo.json` 补 `globalEnv` + `globalDependencies`；`turbo run build --dry=json` 验证。
   —— 不做这步，后面所有隔离都可能被缓存绕过。
2. **修 §7.2**：`.dockerignore` 补上私有配置路径。
3. **落 capability registry**（`packages/shared/src/capabilities.ts`），只有表，无行为。
4. **落服务端解析器与求值器**（`apps/bff/src/lib/operator-config.ts`），读 gitignored operator 配置，缺失回落默认值、存在但无效则拒绝启动，求值不抛异常，启动打一行来源汇总。
5. **拆 `config.auth.enabled` 的四个调用点**，一次一个语义：
   登录要求 → capability；行归属 / 去重归属 → 取决于「有没有 userId」这个本地事实，不该经过版本 flag；
   cache-control → 取决于响应是否 user-scoped。
6. **加 `GET /api/capabilities`**（只下发 `client: true` 的子集），`AuthGate.tsx` / `Header.tsx` 改吃它；
   `runtime-config.json` 只保留「还没连上 BFF 之前必须知道的东西」（`bff.enabled` / `bff.baseUrl`），卸掉 `auth.enabled`。
7. **私有配置收敛成一个文件**：`channels.example.json` 提交、`channels.json` `git rm --cached` + gitignore、
   `OPERATOR_CONFIG_FILE` 指向仓库外路径；`.gitignore` + `.dockerignore` + CI `git check-ignore -q` 三重保险。
8. **（可选，需要产物级隔离时）** Dockerfile 加一个 `paid-runtime` stage，或起 `docker-bake.hcl` 出两个 tag。
   注意：这一步会把 config 拉进 build 阶段，与 12-Factor 相悖；
   Mattermost 的做法（**同一个镜像 + 不同 `.env`**）更干净，只有在需要「零挂载即可独立部署的付费产物」时才用 `--target`。
9. **（可选）** 抄 n8n 的单向 import 规则，防止边界腐烂。

关于版本切换的清洁度：**优先用「模块存在性」而不是 env**（PostHog / Grafana 模型）。
`await import('./private/index.ts').catch(() => null)` 的失败模式是「退回免费版」，
而 `AUTH_ENABLED` 的失败模式是「忘了设 → 付费能力裸奔」。这两个默认值的差别，就是长期能不能省心的差别。

---

## 9. 未验证 / 边界

- **Biome 能否表达 n8n 那条路径条件 import 规则** —— 未读 Biome 规则参考。表达不了就写脚本。
- **`resolve.conditions` 对 workspace 链接包（`workspace:*` 源码包）在 Vite 6 里的行为** —— 文档没写。
  真要走 condition 方案，先花 10 分钟做个原型验证。
- **Vite 7 换了 `define` 的引擎**：当前 vite.dev 写的是 Oxc 而非 esbuild，且 `build.rollupOptions` → `build.rolldownOptions`。
  如果版本消除依赖 `define` 的折叠语义，Vite 7 升级就是**正确性相关**的变更，不是例行升级。
- **`gitlab-license` gem 与 `@n8n_io/license-sdk` 的签名算法** —— 源码不可公开读取，只验到「是 base64 ASCII 文件」「npm 上是 UNLICENSED」。
- **`grafana-enterprise` 私有仓库** —— 404，不可读。可验证的只有「公开仓库里没有 ee/、`LICENSING.md` 无商业条款、
  `pkg/extensions/` 是占位、Makefile 判一个公开仓库里不存在的文件」。
- **OpenFeature 规范里没有关于客户端 flag 机密性的规范性表述**（逐页读过 `01`/`02`/`03`/glossary）。
  安全结论请引 ASVS V8.3.1，不要引 OpenFeature。
- **Vercel 每套餐「同一仓库可连多少 Project」的具体数字** —— 文档只说 "limited depending on your plan"，未取到数值。

---

## 10. 一手来源清单

**原则 / 规范**
12-Factor <https://12factor.net/config> · <https://12factor.net/build-release-run> ·
OWASP ASVS 5.0 V8/V9 <https://raw.githubusercontent.com/OWASP/ASVS/master/5.0/en/0x17-V8-Authorization.md> ·
OWASP Authorization Cheat Sheet <https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html> ·
OpenFeature spec <https://openfeature.dev/specification> · RFC 7519 · RFC 8032

**工具链**
Vite 6 <https://v6.vite.dev/config/shared-options.html#define> · <https://vite.dev/guide/env-and-mode> ·
esbuild <https://esbuild.github.io/api/#define> ·
Rollup <https://rollupjs.org/configuration-options/#treeshake-modulesideeffects> ·
Node <https://nodejs.org/api/packages.html#conditional-exports> ·
TypeScript <https://www.typescriptlang.org/tsconfig/#customConditions> ·
Bun <https://bun.com/docs/bundler> · <https://bun.com/docs/runtime/environment-variables> ·
Turborepo <https://turborepo.com/docs/crafting-your-repository/using-environment-variables> · <https://turborepo.com/docs/reference/configuration> ·
pnpm <https://pnpm.io/cli/deploy> · <https://pnpm.io/cli/install>

**Git / 密钥**
<https://git-scm.com/docs/gitignore> · <https://git-scm.com/docs/git-update-index> · <https://git-scm.com/docs/git-check-ignore> ·
<https://getsops.io/docs/> · <https://github.com/FiloSottile/age> · <https://github.com/AGWA/git-crypt> ·
<https://docs.github.com/en/actions/reference/security/secrets> · <https://docs.github.com/en/code-security/concepts/secret-security/push-protection> ·
<https://github.com/actions/checkout>

**容器 / 部署**
<https://docs.docker.com/build/building/multi-stage/> · <https://docs.docker.com/reference/dockerfile/#arg> ·
<https://docs.docker.com/build/building/secrets/> · <https://docs.docker.com/build/bake/reference/> · <https://docs.docker.com/build/concepts/context/> ·
<https://docs.netlify.com/build/configure-builds/file-based-configuration/> · <https://vercel.com/docs/environment-variables> ·
<https://developers.cloudflare.com/workers/wrangler/environments/> · <https://www.sqlite.org/lang_attach.html> ·
<https://orm.drizzle.team/docs/drizzle-config-file>

**双版本项目源码**
PostHog LICENSE / `ee/LICENSE` / `posthog/settings/web.py` / `.github/workflows/foss-sync.yml` ·
GitLab <https://gitlab.com/gitlab-org/gitlab/-/raw/master/LICENSE> · `lib/gitlab_edition.rb` · `ee/app/models/gitlab_subscriptions/features.rb` · <https://docs.gitlab.com/development/ee_features/> ·
<https://about.gitlab.com/blog/merging-ce-and-ee-codebases/> · <https://about.gitlab.com/blog/a-single-codebase-for-gitlab-community-and-enterprise-edition/> ·
n8n `LICENSE.md` / `packages/@n8n/eslint-config/src/rules/no-import-enterprise-edition.ts` / `packages/cli/src/license.ts` / `packages/@n8n/constants/src/index.ts` ·
Bitwarden `LICENSE.txt` / `src/Api/Startup.cs` / `src/Api/Api.csproj` ·
Metabase `LICENSE.txt` / `src/metabase/premium_features/{defenterprise,token_check,settings}.clj` ·
Plausible `lib/plausible.ex` / `mix.exs` / `extra/COPYING.txt` ·
Mattermost `server/enterprise/README.md` / `server/Makefile` / `server/einterfaces/` ·
Grafana `pkg/extensions/main.go` / `Makefile` / `LICENSING.md` ·
Sentry `src/sentry/features/{manager,base,permanent}.py` · <https://develop.sentry.dev/backend/application-domains/feature-flags/flagpole/> ·
Cal.com `calcom/cal.diy` commit `ab21c7f`
