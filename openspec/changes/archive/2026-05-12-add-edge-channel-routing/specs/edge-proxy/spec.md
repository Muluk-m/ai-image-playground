## ADDED Requirements

### Requirement: Edge proxy route shape

Cloudflare Pages Function MUST 以 `functions/api-proxy/[channelId]/[[path]].ts` 形式响应路径 `/api-proxy/<channelId>/<path>` 的请求。Function 仅 MUST 接受 HTTP 方法 `POST`、`GET`、`OPTIONS`。其它方法 SHALL 返回 405。

#### Scenario: 正常 POST 请求被转发

- **WHEN** 客户端发送 `POST /api-proxy/qlj-openai-gpt-image/images/generations` 含 JSON body
- **THEN** Function SHALL 解析 channelId 与 path
- **AND** 向 `https://api.openai.com/v1/images/generations` 发起 POST，注入 `Authorization` header，body 透传
- **AND** 上游响应（含 status、headers 关键项、body）SHALL 透传回客户端

#### Scenario: 方法不在白名单时返回 405

- **WHEN** 客户端发送 `DELETE /api-proxy/qlj-openai-gpt-image/anything`
- **THEN** Function SHALL 返回 HTTP 405

### Requirement: Channel lookup and disabled handling

Function MUST 通过 `channelId` 在 `config/channels.json` 中精确匹配 channel 记录。匹配失败或匹配到 `disabled: true` 的 channel SHALL 拒绝请求。

#### Scenario: channelId 不存在时返回 404

- **WHEN** 请求路径中的 channelId 在配置中不存在
- **THEN** Function SHALL 返回 HTTP 404 与结构化错误体 `{ error: 'channel_not_found', channelId }`

#### Scenario: channel 被 disabled 时返回 503

- **WHEN** 命中的 channel 配置 `disabled: true`
- **THEN** Function SHALL 返回 HTTP 503 与结构化错误体 `{ error: 'channel_disabled', channelId }`

### Requirement: Path allowlist enforcement

Function MUST 校验请求 path（不含 query string）严格等于 `channel.allowedPaths[]` 中的某一项；MUST NOT 使用 prefix 或正则匹配，避免 path traversal 或意外路径滥用上游密钥。

#### Scenario: path 不在白名单时返回 403

- **WHEN** 某 channel 的 `allowedPaths: ["images/generations", "images/edits"]`
- **AND** 客户端请求 path 为 `chat/completions`
- **THEN** Function SHALL 返回 HTTP 403 与结构化错误体 `{ error: 'path_not_allowed', channelId, path: 'chat/completions' }`

#### Scenario: path 含 traversal 字符时返回 403

- **WHEN** 客户端请求 path 包含 `..` 或经 URL-decode 后异于 allowedPaths 中字面值
- **THEN** Function SHALL 返回 403 而非透传

### Requirement: Auth injection

Function MUST 根据 `channel.auth.type` 注入凭据：

- `type: 'bearer'` → 设置请求 header `Authorization: Bearer ${env[secretRef]}`
- `type: 'query-key'` → 默认在转发 URL 上追加 `?<queryParam | 'key'>=${env[secretRef]}`；若 `auth.headerName` 存在则改为设置该 header 名而不写入 query

客户端请求中的 `Authorization` header MUST 在转发前被剥除，不得传到上游；其它无关 header（如 `cookie`、`x-forwarded-*`）SHALL 不被透传。`Content-Type` 与 body 透传。

#### Scenario: bearer 注入

- **WHEN** channel `auth: { type: 'bearer', secretRef: 'OPENAI_API_KEY' }`
- **AND** 环境变量 `OPENAI_API_KEY=sk-real`
- **THEN** 转发到上游的请求 header 中 `Authorization: Bearer sk-real`

#### Scenario: query-key 注入

- **WHEN** channel `auth: { type: 'query-key', secretRef: 'GEMINI_KEY', queryParam: 'key' }`
- **AND** 环境变量 `GEMINI_KEY=AIzaReal`
- **THEN** 转发到上游的 URL 包含 query `?key=AIzaReal`
- **AND** 上游响应原样回传

#### Scenario: 客户端送来的 Authorization 被剥除

- **WHEN** 客户端请求 header 含 `Authorization: Bearer attacker-supplied`
- **THEN** 转发到上游的请求 header 中该 `Authorization` 被替换为 Function 注入的值，不保留客户端原值

### Requirement: Secret resolution failure handling

若 `env[channel.auth.secretRef]` 在 Pages 运行时不存在或为空字符串，Function MUST 拒绝转发并返回 500 与结构化错误体，且 SHALL NOT 把空字符串作为密钥发往上游。

#### Scenario: 密钥未配置

- **WHEN** channel 的 `secretRef` 指向未配置的环境变量
- **THEN** Function SHALL 返回 HTTP 500 与 `{ error: 'secret_missing', secretRef }`
- **AND** Function SHALL NOT 向上游发起任何请求

### Requirement: Response streaming and timeout

Function MUST 以流式 (`ReadableStream`) 方式回传上游响应 body，不缓冲全部内容。Function SHALL 应用 `channel.defaults.timeout`（秒）作为上游请求总超时；超时时返回 504 与结构化错误体 `{ error: 'upstream_timeout', channelId }`。

#### Scenario: 大响应流式回传

- **WHEN** 上游返回 5 MB 的 b64_json image payload
- **THEN** 客户端 SHALL 在上游 first byte 后立即开始接收数据，不等待 Function 缓冲完整 body

#### Scenario: 上游超时

- **WHEN** 上游在 `timeout` 秒内未完成响应
- **THEN** Function SHALL 中止上游请求并返回 504

### Requirement: CORS for OPTIONS preflight

Function MUST 对 `OPTIONS` 请求返回允许 `POST` 与 `GET`、允许 `Content-Type` header、`Access-Control-Allow-Origin: *`（或精确 origin，按部署需求）的 CORS 响应，以兼容跨域 dev/staging 场景。

#### Scenario: 浏览器预检通过

- **WHEN** 客户端发送 `OPTIONS /api-proxy/...` 含 `Origin` header
- **THEN** Function SHALL 返回 204 与允许 POST/GET 的 CORS headers
