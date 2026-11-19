# 文档站演示录像

对着 `https://test.muvloom.online` 按 `docs/plans/docs-site-rewrite/video-shot-list.md` 重录指南成片。不要把 `BASE` 改成生产域名，脚本会拒绝。

凭据只从环境变量读取，不要写进仓库，也不要出现在命令回显里：

```sh
export DOCS_VIDEO_EMAIL=...
export DOCS_VIDEO_PASSWORD=...
npm install --prefix /tmp/pw --no-package-lock --no-save playwright@1.58.2
node /tmp/pw/node_modules/playwright/cli.js install ffmpeg
PLAYWRIGHT_MODULE=/tmp/pw/node_modules/playwright node scripts/docs-videos/record.mjs 01
```

不带参数时按脚本里的顺序录全部。原始 webm 在 `scripts/docs-videos/raw/`（gitignore）。

1080p 母带走 CDP 截屏（`DOCS_VIDEO_HD=1`，默认开），写到 `scripts/docs-videos/raw/hd/`，libx264 CRF 16。不要拿 Playwright 自带的 1 Mbps webm 再压一次。

从母带剪 01/02/03/06/07：

```sh
python3 scripts/docs-videos/finish.py
```

等待段按 8–16 倍快进，只留约两秒。成片是 CRF 18 的 H.264，另有 VP9 WebM 和 WebP 封面，不加营销字幕。`encode.mjs` 是旧的低码率路径，不要再用它盖掉这批成片。

视频写到 `scripts/docs-videos/out/`（已 gitignore，不要提交 mp4 / webm / mov）。封面 `*-poster.webp` 的源文件放在 `apps/web/public/guide-assets/zh/clips/`。宣传片 `promo-site-zh` 由 `scripts/promo-film/` 单独制作；`workbuddy-tutorial` 是含安装、浏览器授权、生图和两端查看的完整教程。中英文指南共用成片，英文页注明界面是中文。完整成片使用 `film: true`，有播放控件、不循环。

## 官网与教程资源

官网和教程的图片、封面、品牌图及视频统一使用 Cloudflare 账号 `4afe694ac3841dc3e433b6369c754346` 的 `ai-images` 桶，公开域名 `https://store.kaleidonova.com`，对象前缀 `muvloom/site/`。不再经过 CMS。用户作品的现有对象和配置不变。

图片源文件保留在 `apps/web/public/{brand,guide-assets,og,website-assets}/`，`site-assets.json` 登记带内容哈希的对象路径；页面通过 `siteAssetUrl()` 引用。视频 URL 集中在 `content/media.ts` 的 `GUIDE_CLIP_URLS`。不要手写页面资源 URL。`legacy-clips.json` 只用于从旧公开地址复制历史成片，不被页面引用。

更新图片后刷新清单：

```sh
python3 scripts/docs-videos/publish-site-media.py --refresh-images
```

用已有的私密环境文件提供 `S3_ENDPOINT`、`S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`；不要提交该文件。脚本要求 AWS CLI 支持 `put-object --if-none-match`，不会覆盖现有对象或枚举用户作品：

```sh
# 先核对清单与已审核的 WorkBuddy 成片，不联网、不上传
python3 scripts/docs-videos/publish-site-media.py
# 上传并逐个下载公开 URL，核对完整 SHA-256 和文件大小
python3 scripts/docs-videos/publish-site-media.py --upload --env-file /path/to/private/app.env
# 已登录指定 Cloudflare 账号时也可用 Wrangler，先检查目标对象再上传
python3 scripts/docs-videos/publish-site-media.py --upload-with-wrangler
# 可重复验收，不需要密钥
python3 scripts/docs-videos/publish-site-media.py --verify-only
```

Wrangler 模式先从 R2 核对同名对象。它没有条件写入参数，有并发发布时使用 S3 的 `--upload` 模式。

`--video-dir` 可指定最终成片所在目录。原始录屏不得上传。报告写到该目录的 `site-media-verification.json`；只有 `complete: true` 且所有对象验收成功后，才发布页面引用。网络、权限或公开域名绑定失败时脚本停止，报告保留未完成状态。旧资源留存，回滚页面时仍可使用。

发布前远端运行 lint、typecheck、website/web 相关测试和构建，部署测试站并检查视频播放、授权片段、图片加载及移动端布局。浏览器离线冒烟从仓库原图回放 CDN 图片，不能代替上述真实公开 URL 验收。`pnpm lint` 继续禁止把视频提交到 public。
