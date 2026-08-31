# apps/web

前端工作台内部约定。仓库级约定见根 `CLAUDE.md`。

## 服务商架构

前端 dispatch 入口在 [`src/lib/api.ts`](./src/lib/api.ts) 的 `callImageApi`，按 profile.source 分两条路径：

| profile.source | 实现路径 | 协议 |
|---|---|---|
| `user-byok` | `openaiCompatibleImageApi.ts` / `geminiImageApi.ts` | 浏览器直连用户填的 baseUrl |
| `builtin-edge` | `queueClient.ts` | 浏览器 → BFF queue（`submit / poll / fetch`） |

**Gemini 请求 header 用 `x-api-key`，不是 `x-goog-api-key`** — 浏览器 CORS preflight 对常见中转网关只放行前者；后端代理通常两个 header 都接受。

## Runtime 配置

[`packages/shared/src/runtime-config.ts`](../../packages/shared/src/runtime-config.ts) 定义 schema。前端 boot 时 fetch `./runtime-config.json`，schema 校验失败 / 文件不存在都 fallback 到 `BAKED_DEFAULTS`（`bff.enabled=false`）。

operator 在部署时写这个文件 — Docker entrypoint (`scripts/docker-entrypoint.sh`) 把 env 模板化写出来；裸跑 / 纯静态部署 operator 自己手写或脚本生成。

## 其它要点

- 用户优先看到「模型名」，profile name 次之（TaskCard、InputBar 下拉等顺序遵循该原则）
- 上游 `/models` 拉取通过 `src/lib/fetchProfileModels.ts`，结果缓存在 store 的 `profileModelCache`
- builtin-edge channel 的 model 可改（用户可在 InputBar 切换），变化通过 `builtinChannelModelSelections` 字段持久化
- 灵感库 (`public/inspiration-manifest.json`) 是同源静态资源，跟着部署走；可通过 `VITE_INSPIRATION_MANIFEST_URL` 覆盖为外部 CDN
