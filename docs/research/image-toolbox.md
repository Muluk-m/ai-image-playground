# 图片工具箱调研：非 AI 的即时图片处理

> 调研日期：2026-09-23。范围：官方产品页 / 官方帮助页 / 官方定价页、WHATWG HTML 规范原文、MDN browser-compat-data、caniuse 数据集、**浏览器引擎源码（WebKit / Chromium / Gecko）**、官方开源仓库与 LICENSE / COPYRIGHT 原文、npm registry 元数据、jsDelivr 产物体积。
> **全部只读观察：未注册任何账号、未上传任何图片、未触发任何一家的付费或 AI 流程。**所有关于效果与压缩率的表述都是各家自己的官方话术，不是实测结论。
> 来源等级标注：不标 = 官方原文直读；`[官抓]` = 官方页面正文经搜索引擎抓取（站点对非浏览器 UA 返回拦截页）；`[二手]` = 第三方来源；`[存疑]` = 未取证。
>
> 相邻文档：AI 侧的工具化能力（超分放大 / 抠图 / 去水印 / 扩图）已在 [ROADMAP](../ROADMAP.md) Lane C 与 [ecommerce-image-competitors.md](ecommerce-image-competitors.md)、[flyelep-product-notes.md](flyelep-product-notes.md) 中跟踪。**本文只写另一半：非 AI、零等待、可纯本地完成的快捷操作。**矩阵末尾的 AI 行只为盘点完整性保留，并统一显式标注。

## 一、先说结论

1. **真正的「桌面级五件套」只有五项：压缩、格式转换、改尺寸、裁剪、旋转/翻转。** 17 家产品里没有一家缺席全部五项，其余 20 多项操作全部是差异化选择。做工具箱的第一优先级不是「多」，是把这五项做到**无上传、无等待、无登录**。
2. **「本地处理」是一条被验证可行、但商业产品几乎全部放弃的路线，因而正是差异点。** 明确宣称纯浏览器处理的只有三家：Squoosh（「Squoosh does not send your image to a server. All image compression processes locally.」[1][2]）、BIRME（「BIRME processes images locally in your browser. Your files do not need to be uploaded to a server」[20]）、bulkresizephotos（首页徽标「Private — no uploading」[22]）。其余每一家——TinyPNG、iLoveIMG、Adobe Express、Canva、Fotor、CloudConvert、佐糖、改图宝——都上传到服务器，**并把服务器成本折算成可售卖的数字上限**：TinyPNG「Up to 20 images, max 5 MB each.」[4]；iLoveIMG 压缩免费档 30 张 / 200 MB、Premium 120 张 / 4 GB[10]；Adobe Express「less than 40MB」[13]；改图宝「图片文件大小如超过 10M 请使用图片编辑软件(如 PS)修图」[31]，并直言「改图宝服务是非常消耗服务器资源的尤其是上传图片……所以我设置了使用次数的限制」[32]。**纯本地方案没有任何这类数字可公布，这是唯一不需要靠付费墙解释的形态。**
3. **Canvas 原生编码只有三种格式，Safari 不能编 WebP、全平台都不能编 AVIF——所以 WASM 编解码器不是优化项而是必需品；而一旦上 WASM，部署形态就被反向约束。** 缺口侧：Chromium 编码器的 `switch` 只有三个 case——`kMimeTypeJpeg` / `kMimeTypeWebp` / `kMimeTypePng`[41]；BCD 记录 `toBlob` 的 `image/webp` 在 Safari 为**不支持**[38]，对应 WebKit Bug 183257「[WPE] Add support for WebP encoding in HTMLCanvasElement」至今开放[43]；BCD 没有任何 `image/avif` 编码条目。更危险的是规范规定**不支持的 type 静默回退 PNG**（「The default is "image/png"; that type is also used if the given type isn't supported.」[36]），特性检测必须验 `blob.type`，`try/catch` 抓不到。代价侧：`wasm-vips` 虽然一步到位，但官方 README 硬性要求 `Cross-Origin-Embedder-Policy: require-corp` + `Cross-Origin-Opener-Policy: same-origin` 的跨源隔离（因为它用 `SharedArrayBuffer`）[57]。跨源隔离是**整份文档**的开关：`cors` 模式的请求不受 COEP 拦截（BYOK 直连上游的 `fetch` 照常可用），但每个不带 `crossorigin` 的跨源子资源都要对方回 CORP 才能加载，`COOP: same-origin` 还会切断与跨源弹窗的 `window.opener`[69]；`@jsquash/avif` 的 `avif_enc_mt.wasm`、`@jsquash/jxl` 的 `*_mt*.wasm`、`@jsquash/oxipng` 的 `pkg-parallel` 同理。**结论是选 `@jsquash/*` 的单线程变体并按操作懒加载**——「压缩 + WebP 转换」实际只需 mozjpeg enc 246 KB + webp enc 275 KB + webp dec 135 KB ≈ 656 KB，而全量 dec+enc 是 7.9 MB[49]。
4. **「压到指定体积（KB/MB）」是中文工具箱的刚需项，西方工具箱明确拒绝做。** 改图宝在主流程里直接给「文件大小限制在 ___ KB 以内」（且注明「只对 JPG 格式图片有效」）[31]；佐糖主打「将 JPG、JPEG、BMP、Webp 等格式图片立即压缩到 Kb 级别」[29]。反面：iLoveIMG FAQ 原文「Can I choose the compression level? **Nope.**」[11]；TinyPNG 只提供自动的 smart lossy；Squoosh 只给质量滑杆不给目标体积。库侧唯一现成的目标体积实现是 `browser-image-compression` 的 `maxSizeMB`（内部二分重编码，`maxIteration` 默认 10）[51]。
5. **证件照 / 九宫格切图 / 长图拼接 / 平铺水印 / 批量重命名，是中文市场与「批量工具」专属项，主流西方工具箱基本为空。** 证件照：改图宝给「一寸、两寸、公务员报名照片、计算机等级、护照签证」[33]，佐糖给「5 寸、6 寸、7 寸等常见相纸规格」排版打印[30]，美图设计室给白/蓝/红底与单人多人[26]——而 Squoosh / TinyPNG / iLoveIMG / BIRME / CloudConvert 全部没有。平铺水印只有改图宝（`/watermark-repeat`，角度+密度+透明度）与 BIRME（「Watermark mode: Single / Pattern」）两家[20][31]。批量重命名只有 BIRME 一家做到产品级（`xxx` 序号占位 + `ORIGINAL-NAME` 关键字）[20]。**取色板、Base64/Data URL 两项，17 家里一家都没有。**
6. **有损 PNG 量化（TinyPNG 的看家本领）是本调研里最明确的许可地雷。** libimagequant 的 COPYRIGHT 原文：「contains extensive changes and additions by Kornel Lesiński licensed under **GPL v3 or later**」，README 进一步写明「For use in closed-source software, AppStore distribution, and other non-GPL uses, you can obtain a **commercial license**」[61]；pngquant 同款双许可[62]。证据链的关键一环：**Squoosh 自己的 `codecs/imagequant/README.md` 明写「License: GPL3」**[3]，而把 Squoosh 编解码器重新打包的 jSquash（Apache-2.0）**刻意没有** imagequant 包——它的包列表只有 avif / jpeg / jxl / oxipng / png / qoi / resize / webp[48]。想做「TinyPNG 同款」只有三条路：买商业许可、改用 MIT 的 `image-q` 或 `UPNG.js`、或整个产品 GPL 化。
7. **HEIC 是唯一必须付出 LGPL 代价的格式，且原生支持只有 Safari 一家。** 解码侧：HEIC 仅 Safari 17 / iOS 17 起原生支持，Chrome / Firefox / Edge 全部不支持[40]。库侧全部落在 LGPL-3.0：libheif 本体「The library `libheif` is distributed under the terms of the **GNU Lesser General Public License**」[63]、`libheif-js`（npm license 字段 `LGPL-3.0`，包体 8.78 MB）、`heic-to`（LICENSE 原文 LGPL-3.0，包体 24.36 MB，内含 libheif 1.22.2）[64]。`heic2any` 的 npm license 字段写 MIT，但它同样是 libheif 的浏览器封装，实际合规状态 `[存疑]`。
8. **画布面积上限是真实天花板，iOS 只有桌面的四分之一，而且编码器各自还有更低的单边上限。** WebKit `CanvasBase.cpp` 的 `maxCanvasArea()`：**iOS 家族 `8192 * 8192`（67,108,864 px），其余平台 `16384 * 16384`（268,435,456 px）**[44]；Chromium `kMaxCanvasArea = 32768 * 8192`（同为 268,435,456 px）且 Skia 单边限 65535[45]；两个引擎的注释都记录「Firefox limits width/height to 32767 pixels」[44][45]。编码器侧：PNG 单边 65535、JPEG `JPEG_MAX_DIMENSION 65500L`[46]、**WebP `WEBP_MAX_DIMENSION 16383`**[47]。一张 iPhone 48MP 原图（8064×6048 = 48,771,072 px）在 iOS 上距上限只剩 27% 余量，两图并排拼接立刻越界——**批量/拼图功能必须先探测上限再决定是否分块**。

## 二、操作 × 产品矩阵

图例：`✓` = 官方页面可证 / `✗` = 官方功能列表中不存在 / `存疑` = 站点被拦截、JS 渲染或官方未说明。**标 `AI` 的行是生成式或模型驱动能力，不属于本文主题的「即时本地工具」**，仅为完整性列出。各列的功能清单依据：Squoosh[1][50]、TinyPNG[4][7]、iLoveIMG[9]、Adobe Express[12]、Canva[16]、Pixlr[17]、Fotor[18]、BIRME[20]、bulkresizephotos[22]、CloudConvert[23]；稿定[官抓]、美图[26][27]、图怪兽/创客贴/佐糖[28]、改图宝[31]、迅捷[35]。

### 2.1 海外产品

| 操作 | Squoosh | TinyPNG | iLoveIMG | Adobe Express | Canva | Pixlr | Fotor | BIRME | bulkresize | CloudConvert |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 压缩（有损/无损） | ✓ | ✓ | ✓ | 存疑 | ✗ | 存疑 | ✓ | ✓ | 存疑 | 存疑 |
| **压到目标体积** | ✗ | ✗ | ✗（官方拒绝） | 存疑 | 存疑 | 存疑 | 存疑 | ✗ | 存疑 | ✗ |
| 格式转换 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 存疑 | ✓ |
| HEIC → JPG/PNG | ✗ | ✓ | ✓ | ✓（仅作输入） | ✓ | 存疑 | ✓（仅批量输入） | ✗ | 存疑 | ✓ |
| SVG → PNG | ✓（栅格化） | ✗ | 存疑 | 存疑 | ✓ | 存疑 | 存疑 | ✗ | 存疑 | ✓ |
| ICO | ✗ | ✗ | ✗ | 存疑 | 存疑 | 存疑 | 存疑 | ✗ | 存疑 | ✓ |
| 改尺寸（像素/百分比） | ✓ | 存疑（仅 API） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 批量改尺寸 | 存疑 | 存疑 | ✓ | ✓（Premium） | ✓（页面级） | ✓ | ✓ | ✓ | ✓ | 存疑 |
| 裁剪 | 存疑 | 存疑（仅 API） | ✓ | ✓ | ✓ | ✓ | ✓ | ✓（含智能焦点） | 存疑 | 存疑 |
| 比例裁剪 | ✗ | ✗ | 存疑 | ✓ | ✓ | ✓（17 预设） | ✓ | ✓ | 存疑 | ✗ |
| 平台尺寸预设 | ✗ | ✗ | 存疑 | ✓ | ✓ | ✓ | 存疑 | ✗ | 存疑 | ✗ |
| 旋转 / 翻转 | 存疑（有 rotate） | ✗ | ✓（仅旋转） | 存疑 | ✓ | 存疑 | 存疑 | ✗ | 存疑 | 存疑 |
| 文字水印 | ✗ | ✗ | ✓ | 存疑 | ✓ | 存疑 | ✓ | ✓ | 存疑 | 存疑 |
| 图片水印 | ✗ | ✗ | ✓ | 存疑 | 存疑 | 存疑 | 存疑 | ✓ | 存疑 | ✗ |
| **平铺水印** | ✗ | ✗ | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 | ✓（Pattern 模式） | 存疑 | ✗ |
| 去 EXIF / 隐私 | 存疑 | 存疑（API 可反向保留） | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 |
| 拼图 / 长图拼接 | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | 存疑 | ✗ |
| 九宫格 / 切图 | ✗ | ✗ | ✗ | 存疑 | ✓（Image Splitter） | 存疑 | 存疑 | ✗ | 存疑 | ✗ |
| 图片转 PDF | ✗ | ✗ | ✗（归 iLovePDF） | ✓ | ✓ | ✓（批量导出） | ✓ | ✗ | 存疑 | 存疑 |
| GIF 制作 | ✓（browserGIF 编码器） | ✗ | ✓（多 JPG→动图） | ✓（视频→GIF） | ✓ | 存疑 | 存疑 | ✗ | 存疑 | 存疑 |
| 滤镜 / 调色 | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | 存疑 | ✗ |
| 边框 / 圆角 / 阴影 | ✗ | ✗ | 存疑（有 frames） | 存疑 | ✓ | ✓ | ✓ | ✓（仅边框） | 存疑 | ✗ |
| 背景填充（纯色/透明） | ✗ | 存疑（仅 API） | ✗ | 存疑 | ✓ | 存疑 | ✓ | ✓（抠图后填色） | 存疑 | ✗ |
| **证件照** | ✗ | ✗ | ✗ | 存疑 | 存疑 | 存疑 | ✓ | ✗ | 存疑 | ✗ |
| **取色板 / 取色** | ✗ | ✗ | ✗ | 存疑 | 存疑 | 存疑 | 存疑 | ✗ | 存疑 | ✗ |
| **Base64 / Data URL** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | 存疑 | ✗ |
| **批量重命名** | ✗ | ✗ | ✗ | ✗ | ✗ | 存疑 | 存疑 | ✓ | 存疑 | ✗ |
| `AI` 抠图 | ✗ | ✗ | ✓ | ✓ | ✓（付费） | ✓ | ✓ | ✓（浏览器内模型） | 存疑 | ✗ |
| `AI` 超分放大 | ✗ | ✗ | ✓ | 存疑 | ✓ | ✓（≤25MP） | ✓ | ✓（2/3/4×，浏览器内） | 存疑 | ✗ |
| `AI` 消除水印 | ✗ | ✗ | ✗ | 存疑 | 存疑 | 存疑 | ✓ | ✗ | 存疑 | ✗ |
| `AI` 扩图 | ✗ | ✗ | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ | 存疑 | ✗ |
| `AI` 老照片修复 | ✗ | ✗ | ✗ | 存疑 | ✓ | 存疑 | ✓ | ✗ | 存疑 | ✗ |
| `AI` OCR / 图转文字 | ✗ | ✗ | ✗ | 存疑 | ✓ | 存疑 | 存疑 | ✗ | 存疑 | 存疑 |

### 2.2 中文产品

| 操作 | 稿定设计 `[官抓]` | 美图（秀秀网页版 / 设计室） | 图怪兽 818ps | 创客贴 | 佐糖 PicWish | 改图宝 | 迅捷图片转换器（桌面） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 压缩 | ✓ | ✓ | ✗ | 存疑 | ✓ | ✓ | ✓ |
| **压到目标体积** | 存疑 | 存疑 | 存疑 | 存疑 | 存疑（宣传「压到 Kb 级」） | **✓（KB 输入，仅 JPG）** | 存疑 |
| 格式转换 | 存疑 | 存疑 | ✗ | 存疑 | ✓ | ✓ | ✓ |
| HEIC → JPG/PNG | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 | ✓ | ✓ |
| SVG → PNG | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 |
| ICO | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 |
| 改尺寸 | ✓ | ✓ | ✓ | ✓（「无损改尺寸」） | ✓ | ✓（≤5000px，只能缩小） | ✓ |
| 批量改尺寸 | 存疑 | ✓（图片批处理） | 存疑 | 存疑 | ✓ | ✓（专业版） | ✓ |
| 裁剪 | ✓ | ✓ | ✓ | 存疑 | ✓ | ✓ | ✓ |
| 比例裁剪 | 存疑 | 存疑 | ✓ | 存疑 | 存疑 | 存疑 | 存疑 |
| 平台尺寸预设 | 存疑 | ✓（电商/小红书/公众号） | ✓（模板类目） | ✓（模板类目） | ✓（电商尺寸） | ✓（**考试/证件**，非社媒） | 存疑 |
| 旋转 / 翻转 | 存疑 | 存疑 | ✓ | 存疑 | 存疑 | ✓ | ✓ |
| 文字水印 | ✓ | 存疑 | 存疑 | 存疑 | 存疑 | ✓ | ✓ |
| 图片水印 | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 | ✓ | 存疑 |
| **平铺水印** | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 | **✓（角度+密度+透明度）** | 存疑 |
| 去 EXIF / 隐私 | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 |
| 拼图 / 长图拼接 | ✓ | ✓ | ✓（100+ 布局） | ✓（四宫格 / AI 拼图） | ✓ | 存疑 | ✓ |
| 九宫格 / 切图 | 存疑 `[官抓]`（编辑器导出「按数量切图」） | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 |
| 图片转 PDF | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 |
| GIF 制作 | 存疑 | ✓ | ✓（模板式） | 存疑 | 存疑 | 存疑 | 存疑 |
| 滤镜 / 调色 | 存疑 | ✓ | 存疑 | 存疑 | 存疑 | 存疑 | ✓ |
| 边框 / 圆角 / 阴影 | 存疑 | ✓ | 存疑 | 存疑 | ✓（图片加阴影） | 存疑 | ✓ |
| 背景填充 | 存疑 | 存疑 | 存疑 | 存疑 | ✓ | ✓（证件照换底色） | ✓ |
| **证件照** | ✓ | ✓ | ✗ | 存疑 | ✓（含相纸排版） | ✓（考试/签证预设） | ✓ |
| **取色板 / 取色** | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 |
| **Base64 / Data URL** | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 |
| **批量重命名** | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 | 存疑 | ✓ |
| `AI` 抠图 | ✓ | ✓ | ✓ | ✓ | ✓（批量 30 张） | 存疑 | ✓ |
| `AI` 超分放大 | 存疑 | ✓ | 存疑 | ✓ | ✓ | 存疑 | 存疑 |
| `AI` 消除水印 | ✓ | ✓ | 存疑 | ✓ | ✓ | 存疑 | ✓ |
| `AI` 扩图 | ✓ | ✓ | 存疑 | ✓ | ✓ | 存疑 | 存疑 |
| `AI` 老照片修复 | 存疑 | 存疑 | 存疑 | 存疑 | ✓ | 存疑 | ✓ |
| `AI` OCR / 图转文字 | 存疑 | 存疑 | 存疑 | 存疑 | ✓ | ✓（专业版） | ✓ |

> **稿定设计全站对非浏览器 UA 返回 HTTP 405**，上表稿定一列全部为搜索引擎抓取的官方页面正文或结果标题，已逐格标注。**Canva 的 `/help/*`、`/features/background-remover/`、`/features/image-converter/` 返回「Unsupported client」**，相关格子来源同理。**美图设计室、图怪兽 AI 工具页、bulkresizephotos 首页为纯 JS 渲染**，静态抓取只拿到 meta 描述。

### 2.3 逐家的额度、计费与处理位置

| 产品 | 处理位置（官方措辞） | 批量 / 体积上限（逐字） | 免费 vs 付费边界 |
| --- | --- | --- | --- |
| **Squoosh** | **本地**：「All image compression processes locally.」[1]；「Images never leave your device since Squoosh does all the work locally.」[2] | 未公开（UI 一次一张 `[存疑]`） | 完全免费，Apache-2.0 开源 |
| **TinyPNG / Tinify** | 服务器：「Simply upload your photos to our website」[5] | 「**Up to 20 images, max 5 MB each.**」[4]；Pro 75 MB / Ultra 150 MB[6]，格式转换 Free+Pro 每会话 3 次、Ultra 无限[8] | Free 20 张/会话；Pro 无限压缩但仍限 3 次转换；Ultra 解锁「Upload folders」[6] |
| **iLoveIMG** | 服务器：「We just keep the files in our servers to allow you download your edited images.」[11] | 逐工具：压缩/改尺寸/转换/旋转/水印 **Free 30 张 200 MB → Premium 120 张 4 GB**；裁剪与编辑器恒为 1 张；抠图/超分恒为 6 MB[10] | Premium $5/月（年付 $60），含 2,000 AI Credits[10]；工具清单见[9] |
| **Adobe Express** | 服务器（上传即受 Terms 约束）[12] | 「**File must be JPEG, JPG, PNG or WebP and less than 40MB**」[13]；抠图「Only one file can be uploaded at a time.」[14] | 「users will be required to upgrade to a premium version ... such as **remove background, bulk resize**」[15] |
| **Canva** | 服务器（云端编辑器）[16] | `[官抓]` 位图 <50 MB 且「not more than 250 million total pixels」；SVG <3 MB `[存疑]` | `[官抓]`「Background remover is included with **paid plans**.」；「Resize is available on these plans: Canva Pro, Teams, Education, Nonprofits.」[16] |
| **Pixlr** | 未声明 `[存疑]`；AI 走托管模型 | 批量编辑器「upload up to **100** photos」，同页又写「edit more than 100 images」[17]；导出 ZIP（JPG/PNG/WebP/PDF） | 批量编辑器免费但「creating a **trial account is necessary**」[17]；Plus $2.49/月含 80 AI Credits |
| **Fotor** | 服务器：「all operations automatically encrypted」 | 「with **up to 50 images per upload**」[18] | 定价表中 Basic（免费）**不含**「Batch editing」与「AI batch edit」[19] |
| **BIRME** | **本地**：「Your images never leave your computer - nothing gets uploaded to any server.」[20]；AI 模型也在本地：「the model is downloaded when needed and cached by your browser, then your images are processed locally without being uploaded」[21] | **未公布任何上限**（「Resize hundreds of images in seconds」），只提示高质量缩放「May crash in some browsers」 | 免费无注册：「BIRME is free to use, requires no signup」[20] |
| **bulkresizephotos** | **本地**（徽标「Private — no uploading」[22]；完整措辞仅见第三方 `[二手][存疑]`） | 「Unlimited usage」「No sign-up」 | 完全免费，无付费档 |
| **CloudConvert** | 服务器 | Free：「Conversion Credits **10 / day**」「Max File Size **1 GB**」「Max Processing Time **5 minutes**」「Concurrent Tasks **5**」[23] | 积分制：「typically consume one credit per minute of conversion time」[23]；共 212 格式，其中图像 42 种 |
| **佐糖 PicWish** | 服务器：「压缩完成后，图片会在上传后的 1 小时被服务器自动删除」[29] | 「批量抠图 支持 **30 张**图片批量处理」「批量头部抠图 单次可处理 **50 张**」[28]；Web 大批量压缩要求下载客户端 | 免费档「Limited Non-HD downloads per day」[28]；算粒/时长会员制 |
| **改图宝** | 服务器：「上传的图片 **30 分钟**内会自动删除」[31] | 免费站 **10M**/张[31]，「只能改十张」额度[32]；专业版 15 MB/张，批量转换「每次最多可同时转换 **12 张**」且 12M/张[34] | 免费站不注册可用但限次；批量、OCR、批量水印在付费专业版 |
| **迅捷图片转换器** | **桌面软件**（Win/Mac + 移动端），非网页工具 | 未公开 | VIP 买断/订阅，一个账号同时只在一台 PC 生效[35] |

## 三、纯前端（无服务端）可行性

### 3.1 编码：canvas 到底能吐出什么

| 输出 MIME | Chrome / Edge | Firefox | Safari (macOS) | Safari (iOS) | 依据 |
| --- | --- | --- | --- | --- | --- |
| `image/png` | `toBlob` 50 | 18 | 11 | 11 | 规范强制支持[36]；BCD[38] |
| `image/jpeg` | 50 | 18 | 11 | 11 | BCD[38] |
| `image/webp` | 50 | **96** | **✗** | **✗** | BCD[38]；WebKit Bug 183257[43] |
| `image/avif` | **✗** | **✗** | **✗** | **✗** | Blink 编码器仅三个 case[41]；BCD 无条目 |
| `toDataURL('image/webp')` | 17 | 96 | ✗ | ✗ | BCD[38] |
| `OffscreenCanvas.convertToBlob` | 69 | 105 | **16.4** | 16.4 | BCD[39] |
| `convertToBlob({type:'image/webp'})` | 69 | 105 | **✗** | ✗ | BCD[39] |

**三条必须写进实现的语义：**

1. **静默回退。** 规范原文：「The default type is `image/png`; that type is also used **if the given type isn't supported**.」[36] 所以 Safari 上请求 WebP 会安静地拿到一个 PNG。**特性检测唯一正确写法是检查回调里 `blob.type`**。
2. **`quality` 不是线性的，而且 WebP 的 `1.0` 是开关而非极值。** Chromium 源码：JPEG 在 `quality` 越界时用默认 **92**，否则 `round(q*100)`；WebP **`quality === 1.0` 时切换到无损模式**（`fCompression = kLossless`，内部 `fQuality` 反而设为 75），否则默认 80[41]。也就是说 `toBlob(cb,'image/webp',1.0)` 产出的是无损 WebP，可能比原图更大。
3. **编码器单边上限低于画布上限。** Blink `ImageEncoder::MaxDimension`：PNG 65535、JPEG `JPEG_MAX_DIMENSION`、WebP `WEBP_MAX_DIMENSION`[41]。查常量定义：`JPEG_MAX_DIMENSION 65500L`[46]、**`WEBP_MAX_DIMENSION 16383`**[47]。长图拼接转 WebP 时 16383 这条会先撞上。

### 3.2 解码：浏览器能吃进什么

| 格式 | Chrome | Firefox | Safari | iOS Safari | 备注 |
| --- | --- | --- | --- | --- | --- |
| WebP | 32 | 65 | **16.0**（14.0–15.6 需 macOS 11 Big Sur） | 14.0 | caniuse 注 #3[40] |
| AVIF | 85 | 93（**仅静态图**，动画序列需 `image.avif.sequence.enabled`） | 16.4 | 16.0（仅静态、不支持 noise synthesis） | caniuse 注 #2 #4 #5[40] |
| HEIC / HEIF | **✗** | **✗** | **17.0** | **17.0** | caniuse[40] |
| JPEG XL | ✗（需 `chrome://flags/#enable-jxl-image-format`） | ✗（Nightly `image.jxl.enabled`） | 17.0 起**部分**：仅静态、不支持渐进解码 | 17.0 同 | caniuse 注 #4 #5[40] |
| APNG | 59 | 3 | 8 | 8 | caniuse[40] |
| 动画 GIF | 全平台原生 | — | — | — | 逐帧拆分需 `ImageDecoder`[37] |

`createImageBitmap`：Chrome 59 / **Firefox 98（不支持 `resizeQuality`，Bugzilla 1363861）** / Safari 17.0（15.4–16.4 为部分支持，`ImageData` 源不支持 `premultiplyAlpha`，WebKit Bug 237082）[40]。
`imageOrientation` 默认值是 **`'from-image'`**——「Image oriented according to EXIF orientation metadata, if present (**default**)」[37]；要拿到未旋转的原始像素必须显式传 `'none'`。`resizeWidth` / `resizeHeight` / `resizeQuality`（`pixelated` | `low`（默认）| `medium` | `high`）可在解码阶段一次完成缩放[37]。

`ImageDecoder`（WebCodecs，可逐帧拆动图）：Chrome 94 / Firefox 133 / **Safari 仅 Technology Preview**[39]。WebCodecs 整体：Chrome 94 / Firefox 130 / Safari 26.0[40]。
`OffscreenCanvas`（Worker 内画布）：Chrome 69 / Firefox 105 / Safari 16.4[39]（caniuse 按 2D+WebGL 口径记为 Safari 17.0[40]）。

### 3.3 画布尺寸上限

| 引擎 / 平台 | 面积上限 | 单边上限 | 依据 |
| --- | --- | --- | --- |
| **WebKit（iOS / iPadOS）** | `8192 * 8192` = **67,108,864 px** | 由面积约束 | `CanvasBase.cpp` `maxCanvasArea()`[44] |
| WebKit（macOS 等） | `16384 * 16384` = 268,435,456 px | 由面积约束 | 同上[44] |
| Chromium | `kMaxCanvasArea = 32768 * 8192` = 268,435,456 px | `kMaxSkiaDim = 65535` | `canvas_rendering_context_host.cc`[45] |
| Gecko | 未按面积约束 | 32767 | 两个引擎源码注释均记「Firefox limits width/height to 32767 pixels」[44][45] |

WebKit 注释把取舍写得很直白：「We limit by area instead, giving us larger maximum dimensions, in exchange for a smaller maximum canvas size.」[44] `browser-image-compression` 的官方 Caveat 也承认这条是它的行为前提：「Each browser limits the maximum size of a browser Canvas object. So, we resize the image to less than the maximum size that each browser restricts.」[51]

### 3.4 元数据、ICC 与色域

- **canvas 重编码 = 无条件剥掉所有元数据。** 规范 §4.12.5.5 原文：「The image file's pixel data must be the bitmap's pixel data scaled to one image pixel per coordinate space unit, and **if the file format used supports encoding resolution metadata, the resolution must be given as 96dpi**」[42]——序列化只写像素与 96dpi，规范没有给 EXIF / IPTC / XMP 留任何写入口。**推论：「去 EXIF / 去 GPS」在纯前端是免费副作用，反而是「保留 EXIF」需要额外工程**（`browser-image-compression` 的 `preserveExif: boolean`[51]，或用 `piexifjs` 回填）。同样的默认值也出现在服务端：sharp 文档写「**By default all metadata will be removed, which includes EXIF-based orientation.**」[60]；Cloudflare Images 则写「For all other output formats (e.g. WebP or PNG), **all metadata will always be discarded**」，JPEG 默认 `metadata=copyright`[24]；imgix「By default, Imgix will strip most metadata (EXIF data, geolocation, etc.)」[25]。
- **色域会被压回 sRGB。** 2D 上下文的 `colorSpace` 默认 `"srgb"`；规范规定序列化时非 sRGB 画布「must be converted to the `'srgb'` color space using `'relative-colorimetric'` rendering intent」[42]。**Display-P3 / Adobe RGB 的原图走一遍 canvas 就会掉色域且丢 ICC**。WebKit Bug 230209「display-p3 canvas toDataURL / toBlob returns sRGB data for JPEGs」记录了相关实现问题[43]。要保色域只能走 WASM 解码 → 处理 → WASM 编码的整条链路。
- **方向已在解码阶段被改写。** 因为 `createImageBitmap` 默认 `from-image`[37]，拿到的位图已按 EXIF Orientation 摆正，之后再写出时 EXIF 又被丢掉——净效果是「自动摆正 + 清方向标」，与 sharp 的 `autoOrient()`（「orient using the EXIF Orientation tag, then **remove the tag**」[60]）等价。

### 3.5 产物投递

| 手段 | 支持度 | 备注 |
| --- | --- | --- |
| `<a download>` + `URL.createObjectURL` | Chrome 14 / Firefox 20 / Safari 10.1 / iOS 13.0[40] | 唯一全平台可用的基线 |
| ZIP 打包 | 库能力，非浏览器能力 | `fflate`（MIT，8 kB 级）[59] |
| `showSaveFilePicker` | Chrome/Edge **86**，Firefox ✗，Safari ✗[39] | 单文件另存 |
| **`showDirectoryPicker`（批量直写目录）** | Chrome/Edge **86**，Firefox ✗，Safari ✗[39]；caniuse 以 File System Access 整体计 105[40] | **只有 Chromium 系可用**，必须有 zip 退路 |

BIRME 的做法可直接照抄：同时提供「Download zip / Download Files / Save into a folder（File System Access API）」三条出口[20]。

### 3.6 参考操作全集（服务端口径，用作功能设计的对照表）

Cloudflare Images 的 URL 参数集是一份紧凑的「操作最小完备集」：`anim`、`background`、`blur`、`border`(仅 Workers)、`brightness`、`compression`、`contrast`、`dpr`(≤2)、`fit`(scale-down/contain/cover/crop/aspect-crop/pad/squeeze/scale-up)、`flip`、`format`、`gamma`、`gravity`(auto/face/方位/坐标)、`height`、`metadata`、`onerror`、`quality`、`rotate`、`saturation`、`segment`(AI 抠图)、`sharpen`、`slow-connection-quality`、`trim`、`upscale`(interpolate/generate)、`width`、`zoom`，外加 Workers 侧的 `draw`（图片/文字叠加，`repeat` 即**平铺水印**，`opacity`、`composite` 混合模式）[24]。其官方限额同样是纯前端方案的参考刻度：远程图 100 MB / **100 MP** / 单边 12,000 px（AVIF 输出 1,200 px），托管图 10 MB；「Cloudflare does not resize SVG files and will ignore any optimization parameters.」[24]

imgix 的分类法更适合做 UI 分组（26 类，官方称 180+ 参数）：Size / Adjustment / Format / Automatic / Fill / Focal Point Crop / Face Detection / Rotation / Background / Border and Padding / Blending / Watermark / Text / Stylize / Trim / Animation / Mask Image / **Color Palette** / Noise Reduction / PDF 等[25]。**其中 Color Palette（取色板）是 17 家消费级工具箱全都没做、而图片 CDN 全都有的一项。** imgix 的画布上限也值得记：「The maximum supported canvas size is **8192px by 8192px**.」[25]——与 iOS WebKit 的上限恰好同量级。

sharp（libvips 绑定）可作为「一个操作到底要暴露多少参数」的上限参考：`resize`（fit `cover`/`contain`/`fill`/`inside`/`outside`，position/gravity，strategy `entropy`/`attention`，kernel `nearest`/`linear`/`cubic`/`mitchell`/`lanczos2`/`lanczos3`(默认)/`mks2013`/`mks2021`，`withoutEnlargement`/`withoutReduction`）、`extend`/`extract`/`trim`、`rotate`/`autoOrient`/`flip`/`flop`/`affine`、`sharpen`/`median`/`blur`/`dilate`/`erode`、`flatten`/`unflatten`、`gamma`/`negate`/`normalise`/`clahe`/`convolve`/`threshold`/`boolean`/`linear`/`recomb`/`modulate`、`tint`/`greyscale`/`toColourspace`、`composite`（含 `tile:true` 平铺、20+ 混合模式、Pango 文字层）[60]。

## 四、库选型

### 4.1 总表

体积一律取 **jsDelivr 上官方发布产物的实际字节数**（未压缩 wasm），不是 gzip 后估算值。维护状态取 npm `dist-tags.latest` 的发布时间与 GitHub `pushed_at`（2026-09-23 查询）。

| 库 | 用途 | 官方产物体积 | 许可 | 最近发布 / 推送 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `@jsquash/jpeg` 1.6.0 | MozJPEG 编解码 | dec **163 KB** + enc **246 KB** | Apache-2.0 | 2025-05-12 | 底层 mozjpeg = IJG + 3-clause BSD[65]，无 copyleft |
| `@jsquash/webp` 1.5.0 | libwebp 编解码 | dec **135 KB** + enc **275 KB**（SIMD 版 337 KB） | Apache-2.0 | 2025-05-12 | **补 Safari 缺失的 WebP 编码，本调研里性价比最高的一颗** |
| `@jsquash/avif` 2.1.1 | libavif 编解码 | dec **1.14 MB** + enc **3.40 MB**（mt 3.45 MB） | Apache-2.0 | 2025-05-20 | 编码器 3.4 MB 是全表最大单体；libavif 为 BSD-2[66]。`_mt` 变体需线程 |
| `@jsquash/png` 3.1.1 | Rust `png` crate 编解码 | **177 KB** | Apache-2.0 | 2025-05-20 | 无损，不做量化 |
| `@jsquash/oxipng` 2.3.0 | PNG 无损再优化 | **160 KB**（parallel 231 KB） | Apache-2.0 | 2024-06-18 | oxipng 本体 MIT |
| `@jsquash/jxl` 1.3.0 | JPEG XL 编解码 | dec **829 KB** + enc **1.33 MB**（mt+simd 1.97 MB） | Apache-2.0 | 2025-07-12 | 浏览器几乎不支持 JXL 解码，做了也只能自产自销 |
| `@jsquash/resize` 2.1.1 | 高质量缩放 | resize **34 KB** / magic-kernel **18 KB** / hqx **132 KB** | Apache-2.0 | 2026-01-05 | 三种算法可按需分包 |
| `wasm-vips` 0.0.18 | 全能图像管线（libvips） | `vips.wasm` **4.97 MB**（+heif 3.39 MB / +jxl 2.12 MB / +resvg 1.13 MB） | 包装 **MIT**[58]，内含 **libvips LGPL-2.1** | 2026-06-09 / 2026-09-22 | **要求 COOP/COEP 跨源隔离**[57]；需 Chrome 95+/Firefox 100+/Safari 16.4+ |
| `browser-image-compression` 2.0.2 | 目标体积压缩 | npm 包 863 KB | MIT | 2023-03-06 / 2024-03-08 | canvas 路线 ⇒ 继承 §3.1 全部限制；`maxSizeMB` / `maxWidthOrHeight` / `useWebWorker` / `preserveExif` / `alwaysKeepResolution`[51] |
| `pica` 10.0.3 | 高质量缩放 | npm 包 1.25 MB | MIT | 2026-08-15 | 自动在 `js` / `wasm` / `cib` / `ww` 间选优；默认 `mks2013` 滤波 + unsharp mask[52]。**BIRME 的高质量缩放引擎就是它**[20] |
| `libheif-js` 1.23.2 | HEIC/HEIF 解码 | npm 包 **8.78 MB** | **LGPL-3.0**[53] | 2026-09-05 | libheif 官方 COPYING 明写 LGPL[63] |
| `heic-to` 1.5.2 | HEIC → JPEG/PNG | npm 包 **24.36 MB** | **LGPL-3.0**（LICENSE 原文）[64] | 2026-05-26 | 跟随 libheif 1.22.2，维护最勤 |
| `heic2any` 0.0.4 | HEIC → PNG/JPEG/GIF | npm 包 2.72 MB | npm 字段 MIT，**内含 libheif `[存疑]`** | 2023-03-29 | 三年未更新 |
| **`libimagequant`** | 有损 PNG 调色板量化（TinyPNG 同款） | 无官方 wasm 包 | **GPL-3.0-or-later 或商业**[61] | 2026-06-21 | **闭源商用必须购买商业许可**；Squoosh 的 `codecs/imagequant/README.md` 自标「License: GPL3」[3] |
| `image-q` 4.0.0 | 调色板量化（RGBQuant / NeuQuant / Wu + CIEDE2000） | npm 包 845 KB | **MIT**（`packages/image-q/LICENSE`）[67] | 2022-01-08 / 2023-10-17 | **GPL 的合规替身**；纯 TS 无 wasm，速度弱于 libimagequant `[存疑]` |
| `upng-js` 2.1.0 | 有损 PNG / APNG 编解码 | — | MIT | 2017-12-12 | Photopea 出品，久未更新但仍是最省事的有损 PNG |
| `gifenc` 1.0.3 | GIF 编码 | npm 包 173 KB | MIT | 2021-03-07 / 2024-09-19 | 「Small library footprint (9KB before GZIP)」、内建 PnnQuant 量化、可多 Worker 并行；**无 dithering**，适合扁平图形而非照片[68] |
| `gif.js` 0.2.0 | GIF 编码 | — | MIT | 2016-12-06 | 十年未发版；gifenc 自称「often more than twice as fast」[68] |
| `jspdf` 4.2.1 | 图片 → PDF | npm 包 30.2 MB | MIT | 2026-03-17 / 2026-09-23 | `addImage` 按魔数识别 PNG / JPEG / JPEG2000 / GIF87a / GIF89a / **WEBP** / BMP / TIFF / RGBA[55] |
| `pdf-lib` 1.17.1 | 图片 → PDF | npm 包 19.5 MB | MIT | 2021-11-06 / 2024-07-17 | **只有 `embedPng` / `embedJpg`**[56]，WebP 需先转码；2021 年后无发版 |
| `exifr` 7.1.3 | 元数据读取 | npm 包 1.29 MB | MIT | 2021-08-05 / 2024-03-29 | 读 EXIF / GPS / **XMP** / **ICC** / **IPTC** / JFIF / IHDR，可只读前几个字节，可抽内嵌缩略图；**只读不写**[54] |
| `fflate` 0.8.3 | ZIP 打包 | npm 包 797 KB | MIT | 2026-05-16 | 「8kB package」[59] |

### 4.2 许可地雷（按风险排序）

1. **`libimagequant` / `pngquant`：GPL-3.0-or-later，或向作者购买商业许可。** COPYRIGHT 原文：「contains extensive changes and additions by Kornel Lesiński licensed under **GPL v3 or later**」[61]；README 给出商业许可入口[61]，pngquant 同款表述[62]。**这是「做一个 TinyPNG」最容易踩的坑**：Squoosh 自己在 `codecs/imagequant/README.md` 里标的就是「License: GPL3」[3]，而 jSquash 的包列表里没有 imagequant[48]——这不是遗漏，是规避。合规替代：`image-q`（MIT）[67] 或 `upng-js`（MIT）。
2. **libheif 全家：LGPL-3.0。** libheif 的 COPYING 原文：「The library `libheif` is distributed under the terms of the GNU Lesser General Public License.」[63]；`libheif-js` npm license 字段即 `LGPL-3.0`；`heic-to` 的 LICENSE 逐字为 LGPL-3.0[64]。LGPL 允许动态链接式使用，但 wasm 静态打包场景下的「可替换性」要求需要单独评估 `[存疑]`。**规避方案**：只在 Safari 17+ 上用原生 HEIC 解码[40]，其余平台提示用户先转 JPG。
3. **`wasm-vips`：包装层 MIT[58]，产物内含 libvips（LGPL-2.1）。** 单看 npm license 字段会误判为纯 MIT。
4. **MozJPEG / libwebp / libavif / oxipng 全部宽松。** mozjpeg 为 IJG + 3-clause BSD 双许可[65]，libavif 为 BSD-2-clause[66]，oxipng 为 MIT——`@jsquash/*` 这条线（自身 Apache-2.0）在许可上是干净的。

### 4.3 两个会反向否决选型的部署约束

- **COOP/COEP。** `wasm-vips` 官方 README 明确要求 `Cross-Origin-Embedder-Policy: require-corp` + `Cross-Origin-Opener-Policy: same-origin`[57]。MDN 明写「requests made in `cors` mode won't be blocked by COEP」，受影响的是 `no-cors` 子资源（不带 `crossorigin` 的跨源 `<img>` / 媒体）必须带 CORP，或改用 `credentialless`[69]；所以 BYOK 直连上游的 `fetch` 不受影响，真正的成本是**整站**所有跨源图片与弹窗都要重新过一遍。单页应用切页不重载文档，这组响应头无法只给工具箱一页。`@jsquash` 的 `*_mt*` 多线程变体（`avif_enc_mt.wasm`、`jxl_enc_mt*.wasm`、`oxipng` 的 `pkg-parallel`）同理——**默认应选单线程变体**。
- **首包体积。** 全量塞入 jSquash 的 dec+enc 是 163+246+135+275+1143+3404+177+160+829+1332 KB ≈ **7.9 MB wasm**。合理做法是按操作懒加载单个 codec：只做「压缩 + WebP 转换」时实际只需 mozjpeg enc(246 KB) + webp enc(275 KB) + webp dec(135 KB) ≈ **656 KB**，AVIF 编码（3.4 MB）单独按需拉取。

## 五、与本仓库的接缝（2026-09-23 按代码核对）

只记事实与它们对设计的直接约束，不做方案取舍。

**页面入口**

- 没有路由库。页面由 `useStore.appMode` 决定：`APP_MODES = ['image','canvas','explore','library']`（`apps/web/src/store.ts:425`），侧栏只列 `NAV_APP_MODES = ['image','explore','library']`（`store.ts:448`），地址表 `APP_MODE_PATHS`（`lib/appPaths.ts:2`），`App.tsx:108-114` 用 if/else 选页，图标表 `MODE_ICONS`（`components/Sidebar.tsx:13-18`），移动端底栏与桌面侧栏共用同一张列表（`Sidebar.tsx:117`、`:184`）。
- 新增一个一级页面要同时动：上面五处、`store` 语料的 `appMode.*`，以及钉住模式列表的两份测试（`__tests__/lib/appRoute.test.ts`、`__tests__/components/sidebar.test.tsx`）。
- 切页走 `pushState`（`lib/appRoute.ts`），文档不重载——§4.3 的 COOP/COEP 只能整站生效。

**可复用的图片代码**（全部是主线程 `HTMLCanvasElement`；`OffscreenCanvas` / Worker 只在视频导出 `composeFilm.ts`、`exportFilm.ts` 里用）

| 符号 | 位置 | 现状 |
| --- | --- | --- |
| `loadImage` / `calculateFitSize` / `canvasToBlob` / `dataUrlToBlob` | `lib/canvasImage.ts:18-88` | 通用；`canvasToBlob` 不校验回退后的 `blob.type` |
| `compressInputImageDataUrls` | `lib/compressInputImage.ts:52` | 参考图上送前的**固定策略**：长边 2048、有 alpha 出 PNG 否则 JPEG 0.85、≤256 KB 原样放行、串行处理控内存峰值。不是用户可调的压缩器 |
| `createImageThumbnail` | `lib/db.ts:573-593` | `toDataURL('image/webp', 0.9)`；按 §3.1，Safari 上会静默产出 PNG 缩略图 |
| `transcodeImageBlobToPng` | `lib/clipboard.ts:33-52` | 仓库里唯一的 `createImageBitmap` 调用 |
| `removeKeyedBackgroundFromDataUrl` | `lib/transparentImage.ts:53-70` | 纯色键控去底（绿/品红），非 AI 抠图 |

裁剪、旋转、翻转、EXIF 方向处理、`ImageDecoder`：**均无**。

**产物出口**

- 单张：`downloadBlob`（`lib/downloadImages.ts:12-21`，对象 URL 40 s 后回收）。
- 打包：`fflate` 已是依赖。画布导出 `zipSync` level 0 + `safeFileName` / `withExtension`（`features/canvas/lib/exportImages.ts:33-51`、`:99-141`，单张不打包直接下载）；数据导出 level 6（`store.ts:2489-2501`）。
- 无 File System Access API 用法。

**图片从哪来、往哪去**

- 入：`useImageDropZone`、`usePasteImageFiles(scope)`（粘贴只在 `useImageInputScope() === scope` 时生效，scope 类型是 `AppMode | 'library'`，新增模式自动得到自己的粘贴域，`hooks/useImageInputScope.ts:5-12`）；`acceptImageFiles` / `filesFromFolderInput` / `collectDroppedFiles` 已支持文件夹拖入（`lib/imageFiles.ts:9`、`:45`、`:96`）；本地历史图经 `loadImageOriginal`（`lib/imageSource.ts:33-36`）。
- 出：创作输入框 `addImageFromFile`（`store.ts:2618`）；画布 `queueCanvasImages` + `setAppMode('canvas')`（`store.ts:817`）；素材库 `importAssetFiles`（`features/library/store.ts:247`）；右键菜单已有复制 / 下载 / 编辑 / 存素材 / 做视频（`components/ImageContextMenu.tsx:72-194`）。
- IndexedDB 以 **data URL** 存图（`StoredImage`，`types.ts:252-275`），比二进制多约 1/3 体积。批量处理的中间产物不应落这张表。

**门禁与形态**

- 纯前端功能不需要能力位：`clientCapabilities` 在无 BFF 时全关（`lib/clientCapabilities.ts:8-14`），但页面本身不受它控制。
- 匿名访客与 Tier 1 纯静态部署都能进任意页面（`auth/AuthGate.tsx:93-114`）；私有 overlay 只接 header、会员与提交门禁，没有「加页面」的接缝（`lib/privateOverlay.tsx:57-69`）。
- 新 i18n 命名空间：新增 `locales/{zh-CN,en}/<ns>.json` 并在两个 `index.ts` 聚合入口登记，类型自动派生（`i18n/index.ts:8-23`）。

**可测性**

- jsdom 不解码图片，仓库没有装 `canvas` / `@napi-rs/canvas`。现有图片测试全是纯函数（`calculateFitSize`、`transparentImage` 的像素函数）。工具箱里能进单测的是纯函数部分：尺寸与裁剪框换算、目标体积的搜索策略、文件命名；真实编解码只能在浏览器里验。

**与 ROADMAP 的关系**

- Lane C 已把「超分放大 / 抠图 / 去水印 / 扩图」这组 AI 工具并入电商三件套（`docs/ROADMAP.md:123`）。本文的非 AI 工具箱不在 ROADMAP 任何一条里，也不占 Lane A「不往画布上加新能力」那条硬约束——它不碰画布、不走计费单元。

## 六、未验证 / 查不到

1. **稿定设计全站（`gaoding.com` / `m.gaoding.com` / `tools-*`）对非浏览器 UA 返回 HTTP 405**；Canva 的 `/help/*`、`/features/background-remover/`、`/features/image-converter/` 返回「Unsupported client」。这两家的所有事实均为搜索引擎抓取的官方页面正文，已在表格中逐格标 `[官抓]`。
2. **美图设计室的各工具子页、图怪兽 AI 工具页、bulkresizephotos 首页为纯 JS 渲染**，静态抓取只能拿到 meta 描述，功能细节与限额均 `[存疑]`。
3. **TinyPNG 的 JXL 支持自相矛盾**：站内导航写「Compress and convert AVIF, JXL, WebP, PNG and JPG」，但定价页三档全部只列「AVIF, WebP, PNG & JPEG」，API 文档也只写「converting between AVIF, WebP, JPEG, and PNG」[6][7]。Web 工具是否真支持 JXL `[存疑]`。
4. **Pixlr 批量上限自相矛盾**：同一页面既写「upload up to 100 photos」又写「edit more than 100 images at once」[17]。
5. **Fotor 免费档能否批量自相矛盾**：定价表把「Batch editing」标为 Basic 不含[19]，批量页 FAQ 却写「可以免费处理部分照片」`[官抓]`。
6. **几乎所有产品都不公开「去 EXIF」是否发生**：全 17 家里没有一家把元数据剥离写成显式功能或显式承诺，故矩阵该行几乎全为 `存疑`。反倒是服务端产品（Cloudflare Images、imgix、sharp）都把「默认剥离」写进了文档[24][25][60]。
7. **像素维度上限**：除 Canva（`[官抓]` 250M 像素）与 Cloudflare Images（100 MP / 12,000 px）外，没有任何一家消费级工具箱公布过像素上限。
8. **`image-q` 与 `libimagequant` 的实际画质/速度差距**未实测 `[存疑]`；`heic2any` 内含 libheif 的许可传染性未做法律核验 `[存疑]`。
9. **jsPDF/pdf-lib 的 npm 包体积**是 `unpackedSize`（含源码与 sourcemap），不等于浏览器实际加载体积。

## 七、来源

1. Squoosh README（隐私声明）：https://github.com/GoogleChromeLabs/squoosh · https://raw.githubusercontent.com/GoogleChromeLabs/squoosh/dev/README.md
2. Squoosh 应用页：https://squoosh.app/
3. Squoosh imagequant 编解码器许可声明：https://raw.githubusercontent.com/GoogleChromeLabs/squoosh/dev/codecs/imagequant/README.md
4. TinyPNG 首页（「Up to 20 images, max 5 MB each.」）：https://tinypng.com/
5. Tinify 压缩页：https://tinify.com/web/compress
6. Tinify Web 定价页：https://tinypng.com/pricing/web · https://tinify.com/pricing/web
7. Tinify API 参考：https://tinify.com/developers/reference/http
8. Tinify 转换页：https://tinify.com/web/convert
9. iLoveIMG 首页与工具列表：https://www.iloveimg.com/
10. iLoveIMG 定价（逐工具张数/体积表）：https://www.iloveimg.com/pricing
11. iLoveIMG FAQ（文件保留策略、「Nope」不可选压缩级别）：https://www.iloveimg.com/help/faq
12. Adobe Express Quick Actions 总览：https://www.adobe.com/express/feature
13. Adobe Express 改尺寸（40MB、社媒预设）：https://www.adobe.com/express/feature/image/resize
14. Adobe Firefly 抠图（单文件、40MB、免费额度）：https://www.adobe.com/products/firefly/features/remove-background.html
15. Adobe Express 定价 FAQ（remove background / bulk resize 为 Premium）：https://www.adobe.com/express/pricing
16. Canva 功能索引与改尺寸页：https://www.canva.com/features/ · https://www.canva.com/features/image-resizer/ ；`[官抓]` https://www.canva.com/help/background-remover/ · https://www.canva.com/help/page-orientation/ · https://www.canva.com/help/upload-formats-requirements/
17. Pixlr 批量编辑器：https://pixlr.com/tools/batch-edit/ ；首页 https://pixlr.com/ ；定价 https://pixlr.com/pricing/
18. Fotor 批量修图（50 张/次）：https://www.fotor.com/batch-photo-editor/
19. Fotor 定价（Basic 不含 Batch editing）：https://www.fotor.com/pricing/
20. BIRME（本地处理、水印 Single/Pattern、重命名、pica、三种导出）：https://www.birme.net/
21. BIRME AI 抠图/超分的本地模型声明：https://www.birme.net/（FAQ 段）
22. Bulk Resize Photos：https://bulkresizephotos.com/en · https://bulkresizephotos.com/en/about
23. CloudConvert 定价与图像转换器：https://cloudconvert.com/pricing · https://cloudconvert.com/image-converter · https://cloudconvert.com/
24. Cloudflare Images 参数全表、metadata 语义与限额：https://developers.cloudflare.com/images/optimization/features/ · https://developers.cloudflare.com/images/get-started/limits/ · https://developers.cloudflare.com/images/optimization/draw-overlays/
25. imgix Rendering API（26 类参数、元数据剥离、8192×8192 画布上限）：https://docs.imgix.com/apis/rendering · https://docs.imgix.com/llms.txt
26. 美图设计室工具索引与证件照：https://www.designkit.cn/tools · https://www.designkit.cn/certified · https://www.designkit.cn/puzzle
27. 美图秀秀网页版：https://pc.meitu.com/
28. 佐糖 PicWish 工具总览与批量额度：https://picwish.cn/create ；定价 https://picwish.com/pricing
29. 佐糖压缩（1 小时删除、压到 Kb 级）：https://picwish.cn/compress-image
30. 佐糖证件照（相纸排版）：https://picwish.cn/remove-background-id-photo
31. 改图宝首页（10M、30 分钟删除、KB 目标体积）与工具页：https://www.gaitubao.com/ · https://www.gaitubao.com/jpg-gif-png · https://www.gaitubao.com/watermark-repeat · https://www.gaitubao.com/bgcolor · https://www.gaitubao.com/dpi
32. 改图宝 FAQ（「只能改十张」与服务器成本说明）：https://www.gaitubao.com/wiki/1325.html
33. 改图宝关于页（5000px 上限、考试/证件预设）：https://www.gaitubao.com/about
34. 改图宝专业版（15MB、批量 12 张 12M）：https://vip.gaitubao.com/ · https://vip.gaitubao.com/format-batch
35. 迅捷图片转换器（桌面软件）：https://www.xunjiepdf.com/image-converter · https://www.xunjiepdf.com/imageconverter-buy
36. MDN `HTMLCanvasElement.toBlob()`（默认 PNG、不支持类型回退 PNG、quality 语义、96dpi）：https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toBlob
37. MDN `createImageBitmap()`（`imageOrientation` 默认 `from-image`、`resizeQuality`）：https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap ；MDN `ImageDecoder`：https://developer.mozilla.org/en-US/docs/Web/API/ImageDecoder
38. MDN browser-compat-data `api/HTMLCanvasElement.json`（`toBlob` / `toDataURL` 的 jpeg/png/webp 支持矩阵）：https://github.com/mdn/browser-compat-data/blob/main/api/HTMLCanvasElement.json
39. MDN browser-compat-data `api/OffscreenCanvas.json`、`api/ImageDecoder.json`、`api/Window.json`（`showDirectoryPicker` / `showSaveFilePicker` / `showOpenFilePicker`）：https://github.com/mdn/browser-compat-data/tree/main/api
40. caniuse 数据集（webp / avif / heif / jpegxl / apng / createimagebitmap / offscreencanvas / webcodecs / native-filesystem-api / download，数据更新日 2026-08-24）：https://github.com/Fyrd/caniuse/blob/main/data.json · https://caniuse.com/
41. Chromium `ImageEncoder`（编码 MIME 仅 jpeg/webp/png；JPEG 默认质量 92；WebP `quality===1.0` 走无损；`MaxDimension`）：https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/platform/image-encoders/image_encoder.cc
42. WHATWG HTML 规范 §4.12.5.4–4.12.5.5（色彩空间转换 + Serializing bitmaps to a file）：https://html.spec.whatwg.org/multipage/canvas.html#serialising-bitmaps-to-a-file
43. WebKit Bugzilla 183257「[WPE] Add support for WebP encoding in HTMLCanvasElement」：https://bugs.webkit.org/show_bug.cgi?id=183257 ；230209「display-p3 canvas toDataURL / toBlob returns sRGB data for JPEGs」：https://bugs.webkit.org/show_bug.cgi?id=230209
44. WebKit `CanvasBase.cpp` `maxCanvasArea()`（iOS `8192*8192`，其余 `16384*16384`）：https://github.com/WebKit/WebKit/blob/main/Source/WebCore/html/CanvasBase.cpp
45. Chromium `CanvasRenderingContextHost::IsValidImageSize()`（`kMaxCanvasArea = 32768 * 8192`、`kMaxSkiaDim = 65535`）：https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/core/html/canvas/canvas_rendering_context_host.cc
46. libjpeg-turbo / mozjpeg `jmorecfg.h`（`JPEG_MAX_DIMENSION 65500L`）：https://github.com/libjpeg-turbo/libjpeg-turbo/blob/main/src/jmorecfg.h · https://github.com/mozilla/mozjpeg/blob/master/jmorecfg.h
47. libwebp `src/webp/encode.h`（`WEBP_MAX_DIMENSION 16383`）：https://github.com/webmproject/libwebp/blob/main/src/webp/encode.h
48. jSquash README（包列表、无 imagequant、Web Worker 定位）：https://github.com/jamsinclair/jSquash
49. jSquash 各包 npm 元数据与 wasm 体积：https://registry.npmjs.org/@jsquash/webp（等）· https://data.jsdelivr.com/v1/packages/npm/@jsquash/avif@2.1.1?structure=flat
50. Squoosh 仓库（Apache-2.0、编解码器目录）：https://github.com/GoogleChromeLabs/squoosh/tree/dev/codecs
51. browser-image-compression README（`maxSizeMB` / `preserveExif` / `maxIteration` / canvas 上限 Caveat）：https://github.com/Donaldcwl/browser-image-compression
52. pica README（js/wasm/cib/ww 自动选优、`mks2013`、unsharp）：https://github.com/nodeca/pica
53. libheif-js：https://github.com/catdad-experiments/libheif-js · https://registry.npmjs.org/libheif-js
54. exifr README（EXIF/GPS/XMP/ICC/IPTC/JFIF/IHDR、只读前几字节、缩略图）：https://github.com/MikeKovarik/exifr
55. jsPDF `addimage.js` 魔数表（PNG/TIFF/JPEG/JPEG2000/GIF87a/GIF89a/WEBP/BMP/RGBA）：https://github.com/parallax/jsPDF/blob/master/src/modules/addimage.js
56. pdf-lib README（仅 `embedPng` / `embedJpg`）：https://github.com/Hopding/pdf-lib
57. wasm-vips README（SharedArrayBuffer、COOP/COEP、引擎版本要求）：https://github.com/kleisauke/wasm-vips
58. wasm-vips LICENSE（MIT）：https://github.com/kleisauke/wasm-vips/blob/master/LICENSE ；libvips 本体 LGPL-2.1：https://github.com/libvips/libvips
59. fflate：https://github.com/101arrowz/fflate
60. sharp API 文档（operation / resize / colour / composite / output；「By default all metadata will be removed」、`autoOrient()`）：https://sharp.pixelplumbing.com/api-operation/ · https://sharp.pixelplumbing.com/api-resize/ · https://sharp.pixelplumbing.com/api-composite/ · https://sharp.pixelplumbing.com/api-output/
61. libimagequant COPYRIGHT 与 README（GPL v3 or later / 商业许可）：https://github.com/ImageOptim/libimagequant/blob/main/COPYRIGHT · https://github.com/ImageOptim/libimagequant#license
62. pngquant COPYRIGHT 与 README（同款双许可）：https://github.com/kornelski/pngquant/blob/main/COPYRIGHT · https://github.com/kornelski/pngquant
63. libheif COPYING（「The library `libheif` is distributed under the terms of the GNU Lesser General Public License.」）：https://github.com/strukturag/libheif/blob/master/COPYING
64. heic-to LICENSE（LGPL-3.0）与 README（跟随 libheif 版本表）：https://github.com/hoppergee/heic-to/blob/main/LICENSE · https://github.com/hoppergee/heic-to
65. mozjpeg LICENSE.md（IJG License + Modified 3-clause BSD）：https://github.com/mozilla/mozjpeg/blob/master/LICENSE.md
66. libavif LICENSE（BSD-2-clause）：https://github.com/AOMediaCodec/libavif/blob/main/LICENSE
67. image-q LICENSE（MIT，含 NeuQuant 附加声明）：https://github.com/ibezkrovnyi/image-quantization/blob/main/packages/image-q/LICENSE
68. gifenc README（9KB、PnnQuant、多 Worker、无 dithering、与 gif.js 的速度对比）：https://github.com/mattdesl/gifenc
69. MDN `Cross-Origin-Embedder-Policy`（`cors` 模式请求不受 COEP 拦截；`require-corp` / `credentialless` 语义；跨源隔离需 COOP `same-origin`）：https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy
