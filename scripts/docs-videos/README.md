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

从母带剪 01/02/03/06/07 和宣传片：

```sh
python3 scripts/docs-videos/finish.py
```

等待段按 8–16 倍快进，只留约两秒。成片是 CRF 18 的 H.264，另有 VP9 WebM 和 WebP 封面。宣传片带片头片尾和圆角字幕，指南片不加营销字幕。`encode.mjs` 是旧的低码率路径，不要再用它盖掉这批成片。

输出在 `apps/web/public/guide-assets/zh/clips/`。宣传片是 `promo-site-zh.mp4`。中英文指南共用这些文件，英文章节会注明界面是中文。
