<div align="center">

# 🎨 Image Playground

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

### 🧷 内置 Profile（部署期注入）
- 通过 `VITE_BUILTIN_PROFILES` 环境变量在构建时注入一组**只读** profile，列表顶部以「内置」徽章展示
- 内置 profile 的 baseUrl / apiKey / 模型 ID 一律不在 UI 暴露、不进 localStorage、不进导出 ZIP
- 用户仍可在主界面参数栏切换模型；想自定义就「新建配置」从零开始

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
- 一键导出 / 导入 ZIP 备份；内置 profile 自动从导出包中剥离

---

## 🚀 部署（Cloudflare Pages）

需要 Node.js 22+ 与 [pnpm](https://pnpm.io/)。

```bash
pnpm install
pnpm deploy:cf
```

`deploy:cf` 等价于 `pnpm gen:channels && tsc -b && vite build && wrangler pages deploy ./dist --project-name=gpt-image-playground`，会构建静态产物并通过 [Wrangler](https://developers.cloudflare.com/workers/wrangler/) 上传到 Cloudflare Pages。

首次执行前需要 `wrangler login` 登录 Cloudflare 账号。

### 构建期环境变量

| 变量 | 作用 |
|---|---|
| `VITE_DEFAULT_API_URL` | OpenAI 兼容服务的默认 baseUrl（缺省 `https://api.openai.com/v1`） |
| `VITE_API_PROXY_AVAILABLE` | 部署是否提供 `/api-proxy/` 同源代理（`true` / `false`） |
| `VITE_BUILTIN_PROFILES` | JSON 数组，注入「内置」profile（见 [`.env.example`](./.env.example)） |

> ⚠️ `VITE_BUILTIN_PROFILES` 中的 apiKey 会被打进静态 bundle，**仅适用于私有部署**。

---

## 🛠️ 本地开发

```bash
pnpm install
pnpm dev          # 启动 Vite dev server
pnpm test         # Vitest 全量
pnpm build        # 构建 (含 tsc -b 类型检查)
pnpm mock:api     # 本地 mock OpenAI 图像 API (scripts/mock-image-api.mjs)
```

将默认 API URL 写到 `.env.local`：

```
VITE_DEFAULT_API_URL=https://api.openai.com/v1
```

### 项目结构

```
src/
  lib/
    api.ts                       # 入口：按 provider 分发请求
    openaiCompatibleImageApi.ts  # OpenAI 兼容协议
    geminiImageApi.ts            # Google Gemini v1beta 原生协议
    builtinProfiles.ts           # 内置 profile 解析 + fallback
    fetchProfileModels.ts        # 上游 /models 拉取
    apiProfiles.ts               # 配置归一化、provider 切换
  components/                    # React UI
  store.ts                       # Zustand 全局状态 + 持久化
docs/superpowers/                # spec 与 implementation plan
```

---

## 🤝 致谢

Fork 自上游开源项目 [CookSleep/gpt_image_playground](https://github.com/CookSleep/gpt_image_playground)（MIT），在此基础上扩展为通用多服务商图像工作台。

## 📄 License

[MIT](./LICENSE)
