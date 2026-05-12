## ADDED Requirements

### Requirement: Channel config source of truth

仓库内的 `config/channels.json` MUST 是所有内置 channel 配置的唯一物理来源。任何客户端代码、Pages Function 代码、构建脚本对内置 channel 的查询都 SHALL 从此文件派生，不得复制或硬编码 channel 字段。

#### Scenario: JSON 中新增 channel 后客户端即可见

- **WHEN** 开发者向 `config/channels.json` 的 `channels[]` 末尾追加一个合法 channel 对象并运行 `npm run build`
- **THEN** 构建产物中 `src/generated/channels.public.json` 包含该 channel 的 public 视图
- **AND** 启动客户端在 profile 列表中能看到该 channel 对应的内置 profile

#### Scenario: 删除 channel 后历史 profile 失效

- **WHEN** 开发者从 `config/channels.json` 删除某个 channel 后重新部署
- **AND** 用户 localStorage 中存在指向该 channelId 的 `source: 'builtin-edge'` profile
- **THEN** 启动迁移 SHALL 丢弃该 profile 并将 activeProfileId 回退到第一个可用 profile

### Requirement: Channel record schema

每个 channel 记录 MUST 包含字段：`id`（kebab-case 字符串）、`kind`（`ProviderKind` 枚举）、`label`（人类可读字符串）、`baseUrl`（HTTPS URL）、`auth`（鉴权描述）、`models[]`（非空数组）、`defaults`（运行时偏好）、`allowedPaths`（字符串数组）。可选字段 `disabled: boolean` 用于临时下线。`id` 在数组内 MUST 唯一。

#### Scenario: 缺失必填字段时构建失败

- **WHEN** `config/channels.json` 中某个 channel 缺少 `auth.secretRef`
- **AND** 运行 `scripts/build-public-channels.mjs`
- **THEN** 构建脚本 SHALL 以非零退出码结束并打印缺失字段位置

#### Scenario: id 重复时构建失败

- **WHEN** `channels[]` 中存在两条记录 `id` 相同
- **AND** 运行构建脚本
- **THEN** 构建脚本 SHALL 报错指出重复的 id 与位置

#### Scenario: secretRef 误填真密钥时构建失败

- **WHEN** 某 channel 的 `auth.secretRef` 形如 `sk-` 或 `AIza` 开头的字符串（疑似真密钥而非 env 变量名）
- **AND** 运行构建脚本
- **THEN** 构建脚本 SHALL 报错并拒绝产出 public 视图

### Requirement: PublicChannel derivation

构建期产物 `src/generated/channels.public.json` MUST 仅包含 `id`、`kind`、`label`、`models`、`defaults`、`disabled`（若存在）字段；MUST 不包含 `baseUrl`、`auth`、`secretRef`、`allowedPaths` 或其它任何敏感字段。该文件 SHALL 在 `vite build` 之前由 `scripts/build-public-channels.mjs` 自动生成，且在 git 中可被忽略或纳入皆可，但 CI/部署流程 MUST 保证其存在且为最新。

#### Scenario: 派生文件不含敏感字段

- **WHEN** 构建脚本运行完成
- **THEN** `src/generated/channels.public.json` 中任一 channel 对象 SHALL 不包含 `baseUrl`、`auth`、`secretRef`、`allowedPaths` 键
- **AND** 字段集与 `PublicChannel` 类型 100% 一致

#### Scenario: disabled channel 仍出现在 public 视图但被标记

- **WHEN** 某 channel 设置 `disabled: true`
- **THEN** public 视图中该 channel 保留 `disabled: true` 字段
- **AND** 客户端 SHALL 在 profile 列表中过滤掉 disabled channel

### Requirement: ProviderKind enumeration

代码层 `ProviderKind` 类型 MUST 仅包含 `'openai-compat'`、`'gemini'`、`'http-template'` 三个值。新增 provider 协议 SHALL 通过新增此枚举值 + 对应 adapter 文件实现；`'http-template'` 在本次 change 中 MUST 不被实际处理（adapter 抛出 not-implemented），仅作为占位预留。

#### Scenario: channel 使用未实现的 kind 时拒绝转发

- **WHEN** Pages Function 收到指向 `kind: 'http-template'` 的 channel 请求
- **THEN** Function SHALL 返回 501 Not Implemented 与结构化错误体 `{ error: 'kind_not_implemented', kind: 'http-template' }`
