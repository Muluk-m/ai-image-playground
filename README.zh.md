<div align="center">

<img src="./apps/web/public/pwa-icon.svg" alt="" width="96" height="96" />

# AI Image Playground

浏览器里的 AI 生图工作台，自带无限画布创作模式 — 填个 API key 即可用，历史与配置全部本地存储。

[![License](https://img.shields.io/badge/License-MIT-10b981?style=flat-square)](./LICENSE)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=white)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.x-FBF0DF?style=flat-square&logo=bun&logoColor=black)](https://bun.sh/)

[English](./README.md) | 中文

[**在线试玩 · image.nainma.online**](https://image.nainma.online/)

</div>

<p align="center">
  <a href="https://image.nainma.online/" target="_blank">
    <img src="./docs/images/canvas-hero.jpg" alt="创作模式 — 在图上手绘标注、描述修改意图，直接在无限画布上迭代" width="900" />
  </a>
</p>

<p align="center"><i>创作模式：圈出想改的地方、写下要求，标注 → 生成 → 合并素材，全在一张画布上完成。</i></p>

## ✨ 能干嘛

两种工作方式，共享一份历史：

### 🎨 创作模式 — 无限画布

- **标注即迭代** — 选中图片，在上面画圈 / 箭头 / 写字，描述修改要求；模型按标注意图出一张干净新图，不带手绘痕迹
- **合并素材** — 框选多张图一起发起，作为参考图合并生成（「把小猫放到小狗旁边」）
- **原地生成** — 不选图时就是纯文生图，结果直接落在画布上、跟素材摆在一起
- **并发不阻塞** — 每次生成都有实时占位框，多个任务并行跑、你继续操作画布，n>1 一次出多张变体
- **刷新不丢** — 画布内容本地持久化；后端模式下进行中的生成刷新页面后自动续跑
- **与工作台打通** — 画布生成同样落入共享历史（可收藏 / 检索 / 复用），工作台的图也能一键发到画布继续创作
- **键盘友好** — 完整快捷键 + 内置速查面板（⌘⏎ 发起生成，V/H/D/E 切工具，撤销重做…）

### 🛠 工作台模式

- **多个模型** — OpenAI、Gemini、自定义 HTTP，自带 API key 即用
- **参考图 + 遮罩** — 最多 16 张参考图，OpenAI 路径支持可视化遮罩编辑器
- **瀑布流历史** — 每次生成连同实际参数本地保存，可收藏、可检索
- **灵感库** — 几百个一键套用的高质量提示词

### ⚙️ 哪都能跑

- **短任务直跑** — 浏览器直连上游，秒级出图
- **长任务也能跑** — 可选「后端模式」处理 30s–5min 的长任务（Gemini 3 Pro 等），任务持久化，刷新页面也不丢
- **不泄密** — 后端模式下 API key 只在服务器 env 里，浏览器永远拿不到
- **纯本地** — 历史、配置、API key 全存浏览器 IndexedDB

<p align="center">
  <a href="https://image.nainma.online/" target="_blank">
    <img src="./docs/images/preview.png" alt="工作台模式" width="900" />
  </a>
</p>

## 🚀 本地试一下

```bash
git clone https://github.com/Muluk-m/ai-image-playground.git
cd ai-image-playground
pnpm install
pnpm dev:web        # 起前端，打开 http://localhost:5173
```

在右上角设置里填一个 OpenAI 或 Gemini 的 API key（baseUrl 留默认）就能生图了。

## 📦 部署

### 选项 1 · 纯静态（最简单）

一键部署：

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/Muluk-m/ai-image-playground&project-name=ai-image-playground&repository-name=ai-image-playground)
[![Deploy to Netlify](https://www.netlify.com/img/deploy/button.svg)](https://app.netlify.com/start/deploy?repository=https://github.com/Muluk-m/ai-image-playground)

仓库已带上 `vercel.json` 和 `netlify.toml`，针对 monorepo 配好了构建命令和产物目录。点按钮跳过去登一下账号、确认下就能跑，零额外配置。

其它静态托管（Cloudflare Pages / GitHub Pages / nginx / S3）也都能用：

```bash
pnpm install && pnpm build
# 把 apps/web/dist/ 上传到你的静态托管
```

用户自己在页面里填 API key，浏览器直连模型上游。**不支持 1 分钟以上的长任务**（edge 平台超时）。

### 选项 2 · Docker（带后端，支持长任务 + 预置服务商）

```bash
docker build -t ai-image-playground .
docker run -p 37377:37377 \
  -e OPENAI_API_KEY=sk-... \
  -e GEMINI_API_KEY=... \
  -v $(pwd)/apps/bff/channels.json:/app/apps/bff/channels.json \
  ai-image-playground
```

打开 `http://localhost:37377` 即可用。`channels.json` 配置预置的服务商列表（默认含 OpenAI + Gemini，operator 改这里就能加新的）。

详细配置（runtime-config / channels.json / 环境变量）见 [`apps/bff/README.md`](./apps/bff/README.md)。

## 🛠 开发

```bash
pnpm install
pnpm dev          # web + bff 同时起
pnpm test         # vitest + bun:test
pnpm typecheck
pnpm lint
```

技术栈：前端 React 19 + Vite · 画布 tldraw · 后端 Bun + Elysia + SQLite · monorepo pnpm + Turbo。

## 🙏 致谢

Fork 自 [CookSleep/gpt_image_playground](https://github.com/CookSleep/gpt_image_playground)（MIT），保留原项目核心 UX（参考图 + 遮罩、瀑布流历史、灵感库、模型快选、实际参数对比）。本 fork 扩展了 Gemini 原生协议、长任务队列模式、可选后端，以及无限画布创作模式。

灵感库提示词数据：
- [freestylefly/awesome-gpt-image-2](https://github.com/freestylefly/awesome-gpt-image-2)（MIT）
- [YouMind-OpenLab/awesome-nano-banana-pro-prompts](https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts)（CC BY 4.0）

## 📄 License

[MIT](./LICENSE)
