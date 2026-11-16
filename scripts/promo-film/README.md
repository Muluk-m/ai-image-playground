# 站点宣传片

首页和使用指南首页的 `promo-site-zh`：16:9、58 秒，纯音乐加少量标签，没有旁白。
一只杯子贯穿全片：原图 → 智能创作一次出四种釉色 → 画布局部重绘（框选多肉换干花）→ 前后擦除对比 →
青釉杯口特写 → 六宫格 → 片尾。画面全部是 test.muvloom.online 上的真实操作和真实出图，不用 AI 视频镜头，不写口号。

Remotion 工程，不在 pnpm workspace 里，依赖单独装。素材、母带、成片都不进仓库（见 `.gitignore`）。

## 1. 录屏

用测试环境账号，凭据只从环境变量读。四张图测试账号要排队约 3 分钟，加局部重绘和特写共约 600 积分。

```sh
npm install --prefix /tmp/pw --no-package-lock --no-save playwright@1.58.2
export PLAYWRIGHT_MODULE=/tmp/pw/node_modules/playwright PROMO_EMAIL=... PROMO_PASSWORD=...
node record/shot-batch.mjs
```

把四张原图放进 `public/img/glaze-{1..4}.png`（米白、赤陶、黑釉、青釉），再录后两段：

```sh
node record/shot-edit.mjs     # 上传 glaze-2，结果用 dl-canvas.mjs 存成 public/img/edit-after.png
node record/shot-detail.mjs   # 上传 glaze-4，结果用 sniff.mjs（OPEN_FIRST=1）存成 public/img/closeup.png
cp public/img/glaze-2.png public/img/edit-before.png
cp ../../docs/plans/docs-site-rewrite/mug-1.png public/img/original.png
```

三个录制脚本在生成失败、超时、ffmpeg 出错或丢帧时都会非零退出，这时母带不能用，看 `raw/debug/<镜头>/` 的截图再重录。

原图从页面拿：画布用 `dl-canvas.mjs <画布URL> <文件>`，对话和作品列表用 `sniff.mjs <URL> <目录>` 拦截原图响应。

屏幕采集按真实窗口的绘制表面出帧，所以 `lib.mjs` 不模拟视口：窗口高度加 87px 顶栏，
`--force-device-scale-factor=2`，母带才是完整的 2880×1620。用 `viewport` 模拟会缺掉页面底部并被放大。

## 2. 对时间点

母带写到 `raw/`，每段旁边有 `*.marks.json`（上传、输入、发送等时刻）。`tools/` 的脚本要 numpy
（`python3 -m pip install numpy`）。四张图各自出现的时刻：

```sh
python3 tools/color-steps.py raw/batch.mp4
```

据此改 `src/timeline.ts` 的 `SRC`。界面布局变了就重新核对 `CROP`；`chatDone` 下沿要避开带积分数字的用时行，
批量等待过程里有套餐排队提示，不要放进成片。

## 3. 渲染

配乐是 Pixabay「Warm Acoustic Guitar」（232912，Pixabay Content License，可商用、无需署名），放到
`public/music/warm-guitar.mp3`；换曲子要用 `tools/beats.py` 重新测 BPM 和第一拍，改 `timeline.ts` 的拍长与 `MUSIC_FROM`。
logo 从 `apps/web/public/brand/muvloom-mark.svg` 复制到 `public/brand/`，母带复制到 `public/raw/`。

渲染和 webm 编码是分钟级任务，放 macmini2。`public/` 被忽略，rmake 不一定同步，直接 rsync 整个目录：

```sh
rsync -a --exclude node_modules --exclude /raw/ ./ macmini2:promo-film/
ssh macmini2 'cd promo-film && npm install && npx tsc --noEmit -p . && npm run render'
scp macmini2:promo-film/out/promo.mp4 out/
ffmpeg -i out/promo.mp4 -c:v copy -af loudnorm=I=-14:TP=-1.5:LRA=11 -c:a aac -b:a 192k -movflags +faststart out/promo-site-zh.mp4
# webm：macmini2 没装 ffmpeg，用 Remotion 自带的 `npx remotion ffmpeg`，VP9 两遍 CRF 34 + Opus 128k
```

首页和指南首页进入视口才加载整片。交付体积：mp4 不超过 15 MB、webm 不超过 8 MB。画面多是静止成图，
CRF 16 母带直接封装就够小（2026-11 这版 58.2 秒：mp4 8.6 MB、webm 4.4 MB）；超了就把 mp4 重编到 CRF 20–23，不要直接封装。

## 4. 上线

按 `scripts/docs-videos/README.md` 用 cms CLI 上传 mp4 和 webm，改
`apps/web/src/features/guide/content/media.ts` 里 `promo-site-zh.*` 的地址；封面换
`apps/web/public/guide-assets/zh/clips/promo-site-zh-poster.webp`（1920×1080）。
