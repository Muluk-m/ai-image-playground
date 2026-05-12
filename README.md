<div align="center">

# 🎨 Qlj Image Playground

**通用图像生成工作台 · 多服务商接入 · 纯本地存储**

[![React](https://img.shields.io/badge/React-19-20232A?style=flat-square&logo=react&logoColor=61DAFB)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-6-646CFF?style=flat-square&logo=vite&logoColor=white)](https://vitejs.dev/)
[![License](https://img.shields.io/badge/license-MIT-10b981?style=flat-square)](./LICENSE)

</div>

---

## ✨ 核心特性

### 🎨 多服务商接入
- **OpenAI 兼容接口**：含 `Images API` (`/v1/images`) 与 `Responses API` (`/v1/responses`)，覆盖 OpenAI 官方 + 各中转 / 自部署兼容服务
- **Gemini 原生协议**：通过 `v1beta/generateContent` 直接调用 `gemini-3.1-flash-image` 等 Google 图像模型
- **自定义 HTTP 服务商**：基于 JSON manifest 描述请求体 / 响应路径，导入即用；同步 / 异步任务均可
- **多配置管理**：每个服务商可保存多套 baseUrl + apiKey + 模型，按需切换、拖拽排序

### 🧷 内置 Channel（边缘节点持密钥）
- `config/channels.json` 声明内置 channel（baseUrl / auth / 模型 / 路径白名单），构建时派生 `src/generated/channels.public.json` 注入客户端
- 真实 API key 仅放在 Cloudflare Pages 环境变量；客户端永远不带 `Authorization`，请求通过 Pages Function `/api-proxy/<channelId>/<path>` 转发
- 内置 channel 在 UI 中以「内置」徽章呈现，baseUrl / apiKey 完全隐藏，模型可在下拉中切换

### 🎛️ 强大的图像生成与编辑
- 参考图与遮罩：支持最多 16 张参考图（剪贴板 / 拖拽 / 文件选择器）；OpenAI 路径可用可视化遮罩编辑器
- 智能尺寸控制：1K / 2K / 4K 快捷预设，自定义宽高自动规整至模型安全范围
- 实际参数对比：抽取 API 响应中真实生效的尺寸 / 质量 / 耗时 / 改写后的提示词，与请求参数高亮对比
- 模型快选：InputBar 参数栏内置「模型」下拉，跨 profile 列出所有可用模型，选中即切配置
- 模型清单拉取：在设置面板点「拉取模型」从上游 `/v1/models` 同步真实可用清单

### 📁 高效历史管理（纯本地）
- 瀑布流 + 画廊：自动保存历史任务，支持按状态过滤、全屏预览、快捷下载
- 桌面端鼠标框选 / Ctrl+⌘ 连选；移动端侧滑多选
- 所有记录与图片只存浏览器 IndexedDB（SHA-256 去重压缩），不经任何第三方服务器
- 一键导出 / 导入 ZIP 备份；内置 channel 自动从导出包中剥离

---

## 🆚 BYOK vs 内置 Channel

| 维度 | 用户自带 Key（BYOK） | 内置 Channel |
|---|---|---|
| 配置位置 | localStorage（用户侧） | `config/channels.json`（仓库） + Pages 环境变量（密钥） |
| API Key 暴露 | 在用户浏览器中；用户自管 | 永不进入客户端 / bundle / source map |
| 请求路径 | 直连上游或经 `/api-proxy/` 同源转发 | 强制经 `/api-proxy/<channelId>/<path>` 转发 |
| `Authorization` Header | 客户端注入 | 客户端永远不带；由 Pages Function 注入 |
| 模型管理 | 用户在 UI 中增删 | 由 `channels.json` 中 `models[]` 决定，UI 只读 |
| 适用场景 | 个人/团队自用 | 团队共享、对外分发但不想暴露密钥 |

---

## 🚀 部署（Cloudflare Pages）

需要 Node.js 22+ 与 [pnpm](https://pnpm.io/)。

```bash
pnpm install
pnpm deploy:cf
```

`deploy:cf` 等价于 `pnpm gen:channels && tsc -b && vite build && wrangler pages deploy ./dist --project-name=gpt-image-playground`，会构建静态产物并通过 [Wrangler](https://developers.cloudflare.com/workers/wrangler/) 上传到 Cloudflare Pages。`functions/` 目录会被 Pages 自动识别为 Pages Functions。

首次执行前需要 `wrangler login` 登录 Cloudflare 账号。

### 内置 channel 工作流

新增或修改一个内置 channel：

1. 编辑 `config/channels.json`，新增条目（`id` 用 kebab-case，`auth.secretRef` 指向环境变量名而非真值）。
2. 本地校验：`pnpm gen:channels` 会校验 schema 并写入 `src/generated/channels.public.json`（仅含客户端可见字段）。
3. 在 Cloudflare Pages dashboard → Settings → Environment variables，把 `auth.secretRef` 中列的变量名添加到 **Production** 与 **Preview** 两个环境，值填入真实 API key。
4. 推送代码，CI 或 `pnpm deploy:cf` 部署。

> ⚠️ `auth.secretRef` 字段是变量名，**不要**直接写 `sk-...`，构建脚本会拒绝形如真密钥的值。

### 构建期环境变量

| 变量 | 作用 |
|---|---|
| `VITE_DEFAULT_API_URL` | OpenAI 兼容服务的默认 baseUrl（缺省 `https://api.openai.com/v1`） |
| `VITE_API_PROXY_AVAILABLE` | 部署是否提供 `/api-proxy/` 同源代理（`true` / `false`，仅影响 BYOK 路径） |

---

## 🛠️ 本地开发

### 基础

```bash
pnpm install
pnpm dev          # 启动 Vite dev server (5173)
pnpm test         # Vitest 全量
pnpm build        # 构建 (含 gen:channels + tsc -b)
pnpm mock:api     # 本地 mock OpenAI 图像 API
```

将默认 API URL 写到 `.env.local`：

```
VITE_DEFAULT_API_URL=https://api.openai.com/v1
```

### 调试内置 channel（Pages Functions）

需要同时跑 Vite 与 wrangler：

```bash
# 终端 1
pnpm dev           # Vite at http://localhost:5173

# 终端 2
cp .dev.vars.example .dev.vars   # 填入真实 secret
pnpm dev:edge      # wrangler pages dev at http://localhost:8788
```

打开 `http://localhost:5173`，Vite 自动把 `/api-proxy/<channelId>/*` 代理到 8788 的 wrangler。`.dev.vars` 已被 `.gitignore`。

如需将代理目标指向其它端口，导出 `EDGE_PROXY_TARGET=http://...` 后再起 `pnpm dev`。

### 项目结构

```
src/
  lib/
    api.ts                       # 入口：按 profile.source 分发
    openaiCompatibleImageApi.ts  # BYOK OpenAI 兼容协议
    geminiImageApi.ts            # BYOK Gemini v1beta 协议
    channels/
      types.ts                   # ClientProfile / PublicChannel schema
      edgeClient.ts              # builtin-edge 请求 → /api-proxy/...
      publicChannels.ts          # 读取构建期派生的 public channels
      profileSelectors.ts        # 统一模型 / 选中态 helper
    apiProfiles.ts               # ClientProfile 归一化、provider 切换
  components/                    # React UI
  store.ts                       # Zustand 全局状态 + 持久化
functions/
  _lib/                          # Pages Function 通用 handler
  api-proxy/[channelId]/[[path]].ts  # 边缘转发入口
config/channels.json             # 内置 channel 真源
scripts/build-public-channels.mjs  # channels.public.json 派生 + 校验
openspec/                        # spec-driven changes
```

---

## 🤝 致谢

Fork 自上游开源项目 [CookSleep/gpt_image_playground](https://github.com/CookSleep/gpt_image_playground)（MIT），在此基础上扩展为通用多服务商图像工作台。

## 📄 License

[MIT](./LICENSE)
