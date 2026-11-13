# 逃逸 bug 台账（2026-10-14 至 2026-11-13）

- 结论：30 天合入 main 的修复类 PR 共 281 个，其中判为生产逃逸 86 个（30%），另有 40 个不确定、41 个流水线、114 个为同一系列未发布代码的跟进修补。
- 逃逸最多的类别：其他逻辑 31、刷新恢复 10、竞态时序 9；本该拦住的层：单元测试 33、浏览器场景 32、组件测试 17。
- 口径偏高提示：其中 37 个仅依据 BUG-N / UX-N / QA 体验测试编号判为逃逸，这些问题可能发现于测试环境，真正的用户可见逃逸下限约 49 个。
- 工作台（非画布、非智能体对话）相关场景见下表「范围」列；全局场景（刷新、登录、发版后旧标签）同样影响工作台。
- 本文件为一次性台账与基线；此后修复生产问题的 PR 打 `escape` 与 `escape:*` 类别标签，按月复算。

## 方法与口径

- 范围：`gh pr list` 合入 main 的 PR 中，标题以 fix/修复/revert 开头，加少量标题明显是修 bug 的（如「…不再…」）。纯 feat/docs/refactor 不计。
- 逃逸判定：标题或正文含用户反馈、线上、BUG-N 体验测试编号记「是」；修同一系列刚合入未发布代码的 review 跟进、同日连续修补记「否」；修 CI/部署/备份脚本本身记「流水线」；信息不足记「不确定」。未逐条对照部署时间，是粗判，不是审计结论。
- 类别与「本该拦住的层」按标题与改动性质判断，是事后推断。
- 直接 fix 提交：抽样 first-parent 上标题无法与 PR 标题对应的 fix 提交 20 条，逐条核对 GitHub 关联 PR，抽查的 6 条全部对应某个 PR（rebase 合并保留了分支提交），未发现绕过 PR 的直接 fix；因此该节数量按 0 计，台账以 PR 为准。

## 汇总

### 类别 × 判定

| 类别 | 逃逸 | 不确定 | 合计修复 |
| --- | --- | --- | --- |
| 刷新恢复 | 10 | 2 | 13 |
| 多标签页 | 1 | 0 | 1 |
| 本地与云端同步 | 8 | 2 | 10 |
| 竞态时序 | 9 | 7 | 19 |
| 视觉布局 | 8 | 2 | 59 |
| 鉴权会话 | 4 | 4 | 14 |
| 上游与重试 | 7 | 5 | 22 |
| 计费 | 8 | 3 | 12 |
| 流水线部署 | 0 | 0 | 41 |
| 其他逻辑 | 31 | 15 | 90 |
| 合计 | 86 | 40 | 281 |

### 逃逸本该被哪一层拦住

| 层 | 逃逸数 |
| --- | --- |
| 单元测试 | 33 |
| 组件测试 | 17 |
| 浏览器场景 | 32 |
| 视觉回归 | 4 |
| 代码评审 | 0 |
| 无法预防 | 0 |

## 前 15 个可复现场景（按逃逸与不确定 PR 数排序）

| # | 场景（可写成浏览器场景测试） | 范围 | 逃逸 PR | 不确定 PR |
| --- | --- | --- | --- | --- |
| 1 | 批量计划卡：新计划作废旧草稿，删项后张数与规则同步 | 智能体 | 10 | 5 |
| 2 | 上游 429/账号池耗尽/长超时：降级回落、不无限重试、不部分交付 | 工作台 / 智能体 | 7 | 5 |
| 3 | 画布上传失败或 0 字节节点不阻塞保存，可重试，旧画布缺原图可保存 | 画布 | 8 | 2 |
| 4 | 首页/快速生成上传坏参考图：标红、拦住发送、可重试、显示进度、不留空项目 | 工作台 | 8 | 1 |
| 5 | 刷新页面后登录态保持：刷新、响应丢失、cookie 被拦截都不丢会话 | 全局（含工作台） | 6 | 3 |
| 6 | 图片档位与会员报价：前端报价与服务端计费一致，会员不被锁在低档 | 工作台（计费） | 6 | 1 |
| 7 | 作品/结果卡显示：不露防改写前缀、标题随改词更新、比例与张数、页脚位置 | 工作台 / 智能体 | 6 | 1 |
| 8 | 发版后长时间打开的旧标签页：分片缺失时自动刷新一次，不白屏 | 全局（含工作台） | 5 | 2 |
| 9 | 手机窄屏官网与注册页：顶栏单行、注册按钮留在首屏、弹层可点 | 官网 | 5 | 0 |
| 10 | 连点发送/连按回车、聊天面板收起时直接出图授权：不中止已发出的一轮、能开跑 | 智能体 | 4 | 0 |
| 11 | 额度/积分不足被拒：不留本机占位项目、不卡死、原因就地标出 | 工作台 | 4 | 0 |
| 12 | 生成中刷新页面：任务恢复并出结果，失败轮与图片生成模式保留 | 工作台 / 智能体 | 3 | 1 |
| 13 | 资产页与侧栏封面：不一直转圈、排队中有占位、默认页签正确 | 工作台 | 3 | 1 |
| 14 | 取消/中止任务：显示已取消、退还积分、不重复生成 | 工作台 | 3 | 0 |
| 15 | 多标签页：A 标签改画布名/删除作品，B 标签同步更新 | 工作台 / 画布 | 2 | 0 |

场景由 PR 人工聚类，一个 PR 只计入一个场景；未归入场景的逃逸 PR 以单点逻辑错误为主，适合单元或组件测试。

## 逐条明细

判定：是=生产逃逸，否=同系列跟进，流水线，不确定。

| PR | 标题 | 逃逸 | 类别 | 本该拦住的层 |
| --- | --- | --- | --- | --- |
| #1246 | fix(admin): 私有侧栏入口改为站内跳转并带上选中态 | 不确定 | 其他逻辑 | 组件测试 |
| #1247 | fix(deploy): reclaim leftover images before pulling | 流水线 | 流水线部署 | 代码评审 |
| #1248 | fix(deploy): keep admin reachable while cloudflared stays up | 流水线 | 流水线部署 | 代码评审 |
| #1251 | fix(web): keep aspect-ratio tiles readable | 否 | 视觉布局 | 视觉回归 |
| #1252 | fix(deploy): let the new admin reach release-router before its health check | 流水线 | 流水线部署 | 代码评审 |
| #1254 | fix(deploy): free a rollback image when the disk is under 8G | 流水线 | 流水线部署 | 代码评审 |
| #1257 | fix(web): 侧栏底部只保留使用指南 | 否 | 视觉布局 | 代码评审 |
| #1259 | fix(admin): show why an agent turn failed | 否 | 其他逻辑 | 单元测试 |
| #1260 | revert(deploy): drop the admin proxy and use Compose admin again | 流水线 | 流水线部署 | 代码评审 |
| #1261 | fix(deploy): publish the admin site when it changes | 流水线 | 流水线部署 | 代码评审 |
| #1262 | fix(web): 启动闪屏的芽标循环播放 | 否 | 视觉布局 | 视觉回归 |
| #1265 | fix(web): tighten the mobile home header | 否 | 视觉布局 | 视觉回归 |
| #1266 | fix(web): use a gray person icon for the logged-out account menu | 否 | 视觉布局 | 视觉回归 |
| #1267 | fix(web): 去掉已有可见文字控件上的重复 tooltip | 否 | 视觉布局 | 代码评审 |
| #1268 | fix(web): 发送成功后让新作品卡进入视野 | 不确定 | 其他逻辑 | 浏览器场景 |
| #1269 | fix(agent): 下一句超时后重试，并用 Haiku 预测用户的下一句 | 否 | 上游与重试 | 单元测试 |
| #1270 | fix(web): 智能创作的图片引用显示为「图片 N」 | 否 | 视觉布局 | 组件测试 |
| #1271 | fix(bff): 深度模型切换 Astra，下一句切换 Luna | 不确定 | 上游与重试 | 无法预防 |
| #1274 | fix(bff): enforce JSON follow-ups and document Pages redirect | 否 | 上游与重试 | 单元测试 |
| #1280 | fix(admin): distinguish recovered errors from unresolved failures | 否 | 其他逻辑 | 单元测试 |
| #1282 | fix(admin): recognize recovered tunnel edge disconnects | 否 | 其他逻辑 | 单元测试 |
| #1287 | fix(web): keep the sidebar open on canvas | 否 | 视觉布局 | 组件测试 |
| #1288 | fix(web): 测试夹具的 git 提交不再走本机 SSH 签名 | 流水线 | 流水线部署 | 代码评审 |
| #1291 | fix: preserve project catalog failure details and track recovery | 不确定 | 其他逻辑 | 单元测试 |
| #1295 | fix(web): 素材页顶部页头不再被撑成两行空白 | 否 | 视觉布局 | 视觉回归 |
| #1297 | fix(build): use Node 24 for release dependency installs | 流水线 | 流水线部署 | 代码评审 |
| #1298 | fix(website): bind prerender preview to IPv4 loopback | 流水线 | 流水线部署 | 代码评审 |
| #1299 | fix(web): preserve Pages routes with clean rewrite targets | 不确定 | 刷新恢复 | 浏览器场景 |
| #1300 | fix(ci): 修复 AI 评审范围串入主干改动 | 流水线 | 流水线部署 | 代码评审 |
| #1304 | fix(auth): preserve workspace through login and account switching | 不确定 | 鉴权会话 | 浏览器场景 |
| #1305 | fix(website): show login before entering workspace | 不确定 | 鉴权会话 | 浏览器场景 |
| #1306 | fix(web): widen default canvas agent panel | 否 | 视觉布局 | 视觉回归 |
| #1307 | fix(admin): omit redundant tooltips on obvious icon actions | 否 | 视觉布局 | 代码评审 |
| #1310 | fix(web): remove redundant tooltips from familiar icon actions | 否 | 视觉布局 | 代码评审 |
| #1312 | fix(web): reuse shared clipboard, overlay, drop zone and dialog behavior | 否 | 其他逻辑 | 组件测试 |
| #1314 | fix(web): finish canvas mobile layout acceptance | 否 | 视觉布局 | 视觉回归 |
| #1315 | fix(web): tighten canvas image arrangement | 否 | 视觉布局 | 视觉回归 |
| #1316 | fix(web): honor canvas chat panel width limits | 否 | 视觉布局 | 视觉回归 |
| #1330 | fix(web): 已登录不闪官网，并补齐 Agent 卡片模型标识 | 是 | 刷新恢复 | 浏览器场景 |
| #1331 | fix(web): dock canvas controls to bottom corners | 否 | 视觉布局 | 视觉回归 |
| #1332 | fix(ci): 只改 admin 时不再重发 C 端站点 | 流水线 | 流水线部署 | 代码评审 |
| #1333 | fix(admin): 提示词页可清除任务筛选，草稿按任务加索引 | 否 | 其他逻辑 | 单元测试 |
| #1334 | fix(web): keep node captions clear of canvas toolbars when fitting | 否 | 视觉布局 | 视觉回归 |
| #1335 | fix(web): stop double-reserving caption space when revealing a node | 否 | 视觉布局 | 视觉回归 |
| #1336 | fix(web): compact generation previews and speed up upload thumbnails | 否 | 视觉布局 | 视觉回归 |
| #1338 | fix(web): cap standalone generation tiles | 否 | 视觉布局 | 视觉回归 |
| #1339 | fix(web): keep generated results in a four-column grid | 否 | 视觉布局 | 视觉回归 |
| #1340 | fix(web): restore generated result gallery grid | 否 | 视觉布局 | 视觉回归 |
| #1341 | fix(web): tidy chat image batch row | 否 | 视觉布局 | 视觉回归 |
| #1342 | fix(ci): 每一边按自己线上的版本判定是否部署 | 流水线 | 流水线部署 | 代码评审 |
| #1343 | fix(web): keep chat image results as tiles while history loads | 否 | 视觉布局 | 视觉回归 |
| #1344 | fix(agent): reuse generated images by media identity | 否 | 其他逻辑 | 单元测试 |
| #1346 | fix(canvas): 全屏文本编辑、Chat 生成与 Agent 节点引用 | 否 | 其他逻辑 | 组件测试 |
| #1347 | fix(web): remove canvas chat thumbnail hover tools | 否 | 视觉布局 | 代码评审 |
| #1348 | fix(bff): route node canvas generation through runNodes | 否 | 其他逻辑 | 单元测试 |
| #1349 | fix(web): focus React Flow nodes from conversation results | 否 | 其他逻辑 | 组件测试 |
| #1351 | fix(web): preserve React Flow reveal ownership | 否 | 竞态时序 | 组件测试 |
| #1353 | fix(dev): restore reproducible cloud tests and CI dispatch | 流水线 | 流水线部署 | 代码评审 |
| #1354 | fix(bff): preserve active tasks during rollout and normalize Agent off settings | 是 | 竞态时序 | 单元测试 |
| #1355 | fix(web): stop composer references from queueing forever | 是 | 竞态时序 | 浏览器场景 |
| #1356 | fix(bff): expose request ids to cross-origin clients | 否 | 其他逻辑 | 单元测试 |
| #1357 | fix(web): improve canvas agent suggestions and clickable reference tiles | 否 | 视觉布局 | 组件测试 |
| #1358 | fix(web): allow retrying unsaved canvas media | 否 | 其他逻辑 | 组件测试 |
| #1359 | fix: report caught delivery failures and exact recovery | 不确定 | 其他逻辑 | 单元测试 |
| #1360 | fix(web): keep canvas agent caret visible beside Tab hint | 否 | 视觉布局 | 视觉回归 |
| #1361 | fix(web): defer hidden canvas history reads | 否 | 竞态时序 | 组件测试 |
| #1362 | fix: render reply images from conversation results | 否 | 其他逻辑 | 组件测试 |
| #1380 | fix(bff): settle aborted turns after dispatch accounting | 不确定 | 竞态时序 | 单元测试 |
| #1381 | fix(web): sign out directly without a data cleanup prompt | 否 | 其他逻辑 | 组件测试 |
| #1382 | fix(test): block full test scripts on the developer MacBook | 流水线 | 流水线部署 | 代码评审 |
| #1383 | fix(test): guard test runs by machine resources instead of hostname | 流水线 | 流水线部署 | 代码评审 |
| #1385 | fix(deploy): include test guard in Docker context | 流水线 | 流水线部署 | 代码评审 |
| #1386 | fix(web): scroll through home creations without expand buttons | 否 | 视觉布局 | 视觉回归 |
| #1388 | fix(web): remove nested image receipt summaries | 否 | 视觉布局 | 代码评审 |
| #1389 | fix(canvas): show text model labels and corresponding logos | 否 | 视觉布局 | 代码评审 |
| #1390 | fix(web): harden canvas connection interactions | 否 | 其他逻辑 | 组件测试 |
| #1392 | fix(canvas): remove repetitive chat model descriptions | 否 | 视觉布局 | 代码评审 |
| #1393 | fix(canvas): fit text model menu width to its contents | 否 | 视觉布局 | 代码评审 |
| #1394 | fix(web): keep scissors and blank drag previews | 否 | 视觉布局 | 组件测试 |
| #1395 | fix(canvas): preserve image aspect ratios | 否 | 视觉布局 | 组件测试 |
| #1396 | fix(web): focus connection targets with one right-side port | 否 | 其他逻辑 | 组件测试 |
| #1397 | fix(web): prevent snapped connections after Escape | 否 | 其他逻辑 | 组件测试 |
| #1398 | fix(bff): give each Agent turn the conversation's pending cards and recent batches | 否 | 其他逻辑 | 单元测试 |
| #1399 | fix(bff): review generation batch results on wake instead of reading analysis findings | 否 | 其他逻辑 | 单元测试 |
| #1400 | fix(bff): let the node canvas Agent turn chat attachments into image nodes | 否 | 其他逻辑 | 单元测试 |
| #1401 | fix(bff): let Agent image tools set the aspect ratio the user asked for | 否 | 其他逻辑 | 单元测试 |
| #1402 | fix(bff): stop Agent tool retry loops and name the closest canvas nodes | 否 | 上游与重试 | 单元测试 |
| #1404 | fix(web): default direct generation on until the user turns it off | 不确定 | 其他逻辑 | 组件测试 |
| #1406 | fix(agent): hold short confirmations and show pending draft cost | 否 | 其他逻辑 | 单元测试 |
| #1407 | fix(bff): accept omitted batch dependencies and name a closed batch run | 否 | 其他逻辑 | 单元测试 |
| #1408 | fix(bff): alert when the same Agent failure repeats | 否 | 其他逻辑 | 单元测试 |
| #1409 | fix(agent): continue once when model output hits the length limit | 否 | 上游与重试 | 单元测试 |
| #1410 | fix(agent): check reconciling tasks and tell the user the result is being confirmed | 不确定 | 本地与云端同步 | 单元测试 |
| #1414 | fix(web): document.cookie 被拦截时仍保留已记住的登录会话 | 是 | 鉴权会话 | 单元测试 |
| #1415 | fix(bff): 自动对账不再被未决任务占满，失败告警按组独立 | 不确定 | 竞态时序 | 单元测试 |
| #1417 | fix(web): 资产页页顶不再凸出一块亮底 | 否 | 视觉布局 | 视觉回归 |
| #1418 | fix(web): 探索和工具箱页高度扣掉面板上下的缝 | 否 | 视觉布局 | 视觉回归 |
| #1421 | fix(deploy): 测试隔离检查按 Docker env-file 语义读配置 | 流水线 | 流水线部署 | 代码评审 |
| #1425 | fix(admin): 缺失的 /assets 资源返回 404，不再回退首页并被缓存一年 | 是 | 刷新恢复 | 单元测试 |
| #1426 | fix(agent): 画布阶段授权按工作台张数报价，直接出图不再被误拦 | 不确定 | 计费 | 单元测试 |
| #1427 | fix(agent): 唤醒轮沿用提案轮的直接出图与出图参数，无提示词素材按描述出图 | 不确定 | 其他逻辑 | 单元测试 |
| #1428 | fix(agent): 分镜流程先素材后首帧，首帧阶段参数出错时回执可直接照做 | 不确定 | 其他逻辑 | 单元测试 |
| #1429 | fix(agent): 运行回报唤醒轮里登记的直接出图授权由原标签页开跑 | 不确定 | 竞态时序 | 单元测试 |
| #1430 | fix(agent): 首帧授权确认后运行卡显示分镜表已定稿；素材张数排查 | 不确定 | 其他逻辑 | 单元测试 |
| #1432 | 画布上短暂的「等待保存」不再闪出重试，持续卡住才提示 | 不确定 | 竞态时序 | 组件测试 |
| #1434 | fix(agent): 节点因模型不可用被拦下时告诉智能体可用模型，直接出图时自己改好重跑 | 不确定 | 其他逻辑 | 单元测试 |
| #1436 | fix(agent): 只有画布模式才有节点工具与画布上下文，Agent 模式只生图改图 | 否 | 其他逻辑 | 单元测试 |
| #1441 | 修复 bff 偶发失败的测试：回合交接竞态与测试收尾 | 流水线 | 流水线部署 | 单元测试 |
| #1442 | 修正视频模型可用性：共用停用过滤、无可用视频模型时拒绝建节点与报价、videoMode 校验与运行日志 | 否 | 其他逻辑 | 单元测试 |
| #1443 | fix(agent): 在模型适配层把 gpt-6 正文开头的 <thinking> 拆成推理块，取代 #1433 | 是 | 上游与重试 | 单元测试 |
| #1461 | 作品卡片标签不再溢出卡片，模型下拉标签不再折行 | 否 | 视觉布局 | 视觉回归 |
| #1463 | 确认门两处收口：匿名会话确认不再抢跑新消息，续跑积分不足撤回并记原因 | 否 | 竞态时序 | 单元测试 |
| #1465 | fix(admin): group fan-out prompt tasks | 否 | 其他逻辑 | 单元测试 |
| #1466 | fix(web): clarify Google identity binding conflict | 不确定 | 鉴权会话 | 单元测试 |
| #1467 | fix(agent): 作废的确认门卡片不再被系统事实当成待确认 | 不确定 | 其他逻辑 | 单元测试 |
| #1468 | fix(batch): 逐张生成完成提示按整组张数显示 | 否 | 其他逻辑 | 组件测试 |
| #1469 | fix(bff): 阶段授权比对 prompt 前还原防改写前缀和构图后缀，修复 no_rewrite 下非 Gemini 阶段出图 409 | 是 | 其他逻辑 | 单元测试 |
| #1470 | fix(stage-auth): 409 拒绝带上错误码，访问日志记录错误码和用户 | 否 | 其他逻辑 | 单元测试 |
| #1472 | fix(batch): 批量生成结果直接以缩略图露在计划卡上 | 是 | 视觉布局 | 组件测试 |
| #1474 | 修复聊天面板收起时直接出图授权不开跑 | 是 | 竞态时序 | 浏览器场景 |
| #1475 | 修复作品卡显示防改写前缀 | 是 | 其他逻辑 | 组件测试 |
| #1476 | 修复排队中被取消的任务显示「失败」 | 是 | 其他逻辑 | 单元测试 |
| #1477 | 修复确认门改提示词后结果卡标题仍是原提示词 | 是 | 其他逻辑 | 组件测试 |
| #1479 | 修复：用户消息里的方向控制符会翻转整段显示（QA BUG-6） | 是 | 视觉布局 | 组件测试 |
| #1480 | 修复：新建对话/画布时控制台必现 404 project_not_found（QA BUG-7） | 是 | 竞态时序 | 浏览器场景 |
| #1481 | 修复：画布上传 0 字节/伪装 .png 静默生成永久「上传中」节点（QA BUG-8） | 是 | 其他逻辑 | 浏览器场景 |
| #1482 | 修复(智能体): 生成计划积分不足时确认前提示，被拒那张就地标出原因 | 是 | 计费 | 单元测试 |
| #1483 | 修复：上传失败的空节点阻塞整张画布保存（BUG-10） | 是 | 本地与云端同步 | 浏览器场景 |
| #1484 | fix(web): make generation diagnostics useful to copy | 否 | 其他逻辑 | 组件测试 |
| #1487 | fix(agent): hide internal canvas IDs from user-facing replies | 否 | 其他逻辑 | 单元测试 |
| #1488 | 修复(智能体): 「再次生成」照常调用生图工具，不再只回文字（BUG-11） | 是 | 其他逻辑 | 单元测试 |
| #1489 | fix(agent,canvas): 4K 复核改用预览并降级、刷新保留失败轮、结果缩略图保持比例 | 是 | 刷新恢复 | 浏览器场景 |
| #1491 | 修复计划还在拟时「全部生成」不提交且误报草稿已失效（BUG-12） | 是 | 竞态时序 | 浏览器场景 |
| #1492 | 修复连点发送或连按回车会中止刚发出的一轮（BUG-13） | 是 | 竞态时序 | 浏览器场景 |
| #1493 | 修复别的标签页改了画布名后本页一直显示旧名称（BUG-14） | 是 | 多标签页 | 浏览器场景 |
| #1497 | fix(canvas): 旧画布里缺原图的上传节点不再一直挡住保存（BUG-15） | 是 | 本地与云端同步 | 浏览器场景 |
| #1499 | 修复：对话视图里点「生成任务」已完成行会跳到对应消息并高亮（BUG-19） | 是 | 其他逻辑 | 组件测试 |
| #1500 | 修复：资产页默认落到「项目」，对话页资产库按钮加文字（BUG-18） | 是 | 其他逻辑 | 组件测试 |
| #1502 | 修复资产页项目封面一直转圈：卡片不随读取转圈、可见优先加载、失败可重试 | 是 | 竞态时序 | 浏览器场景 |
| #1503 | 修复：逐张生成卡缩略图点击直接放大预览 | 否 | 视觉布局 | 组件测试 |
| #1506 | fix(canvas): preserve server-held candidate media | 不确定 | 本地与云端同步 | 单元测试 |
| #1507 | fix(web): isolate and reset missing canvas media timers | 不确定 | 竞态时序 | 组件测试 |
| #1508 | fix(canvas): bind upload leases while preserving legacy merge order | 是 | 本地与云端同步 | 单元测试 |
| #1511 | fix: preserve failed lazy imports and clarify frontend error recovery | 不确定 | 刷新恢复 | 浏览器场景 |
| #1513 | fix(web): wait for saved images before automatic review | 不确定 | 竞态时序 | 组件测试 |
| #1516 | fix(web): version revised batch guide diagram assets | 否 | 视觉布局 | 代码评审 |
| #1517 | fix(web): recover slow startup and interrupted media uploads | 是 | 刷新恢复 | 浏览器场景 |
| #1518 | fix(bff): cap streamed tool-call arguments per model call | 否 | 上游与重试 | 单元测试 |
| #1520 | fix(bff): prevent repeated parsing of streamed tool arguments | 否 | 上游与重试 | 单元测试 |
| #1522 | fix(web): never show raw exception messages to users | 否 | 其他逻辑 | 代码评审 |
| #1523 | fix(bff): 正确处理下一句建议为空的完成状态 | 不确定 | 其他逻辑 | 单元测试 |
| #1524 | fix(web): recover transient downloads and reject HTTP error files | 不确定 | 上游与重试 | 单元测试 |
| #1525 | fix(bff): enforce the model output budget and stop looping output client-side | 不确定 | 上游与重试 | 单元测试 |
| #1527 | fix(bff): block canvas copies with unresolved media, independent of upload clocks | 是 | 本地与云端同步 | 单元测试 |
| #1528 | fix(web): add retry actions to failed canvas nodes | 否 | 其他逻辑 | 组件测试 |
| #1530 | fix(bff): 关掉 Bun fetch 自带的 300 秒超时 | 是 | 上游与重试 | 单元测试 |
| #1531 | fix(bff): 输入原件转存遇到存储瞬时错误时重试任务 | 不确定 | 上游与重试 | 单元测试 |
| #1532 | fix(web): 发版后长时间打开的标签页仍能自动刷新一次 | 是 | 刷新恢复 | 浏览器场景 |
| #1533 | fix(web): 没有服务端分割时范围确认卡不提供点选 | 否 | 其他逻辑 | 组件测试 |
| #1535 | fix(web): 没有账号或计费的部署不显示登录提示和套餐入口 | 否 | 其他逻辑 | 组件测试 |
| #1540 | feat(web): 旋转编辑器改用单图预览并修复溢出 | 不确定 | 视觉布局 | 组件测试 |
| #1542 | fix(agent): 结果卡与计划卡按实际提交的比例显示（BUG-20/BUG-30） | 是 | 视觉布局 | 组件测试 |
| #1544 | fix(home): 首页交给智能体的坏参考图当场拦住发送，不再留下空项目（BUG-27） | 是 | 其他逻辑 | 浏览器场景 |
| #1547 | fix(agent): 纯文字需求也能出批次计划卡（BUG-25） | 是 | 其他逻辑 | 单元测试 |
| #1548 | fix(agent): 中止一轮时一并取消本轮未完成的生成任务并退还积分（BUG-32） | 是 | 计费 | 单元测试 |
| #1550 | fix: 上传上限回退、直传进度与卡死重试、联网超时文案、竖拍照片宽高（BUG-37/38 + P3） | 是 | 其他逻辑 | 浏览器场景 |
| #1551 | fix(agent): 消息超过 4000 字时说明上限（BUG-31） | 是 | 其他逻辑 | 单元测试 |
| #1552 | fix(agent): 超大图改图前等比缩到最长边 4000（BUG-35） | 是 | 其他逻辑 | 单元测试 |
| #1553 | fix(agent): 同一轮被完整计划覆盖的旧草稿作废，删项后同步总数（BUG-39） | 是 | 其他逻辑 | 单元测试 |
| #1555 | fix(agent): 出图结果后还有取消的卡时，本轮页脚落到本轮末尾（BUG-40） | 是 | 其他逻辑 | 组件测试 |
| #1556 | 修复首页上传失败可重试并阻止发送、智能体折叠进度、旧 EXIF 记录尺寸、首页坏图原因（BUG-41~44） | 是 | 其他逻辑 | 浏览器场景 |
| #1557 | fix(agent): 取网图超限归为来源不可用，不再显示「参数不成立」 | 是 | 上游与重试 | 单元测试 |
| #1558 | 首屏超字数先拦下不建空项目；建会话失败上报真实原因（BUG-45 诊断） | 是 | 其他逻辑 | 组件测试 |
| #1559 | fix(agent): 新计划作废先前轮次未确认的计划，删项后规则与智能体上下文同步（BUG-39） | 是 | 其他逻辑 | 单元测试 |
| #1560 | fix(agent): 超大网图自动缩到最长边 4000 再收进来，取到网页时不再说参数不成立（BUG-47、BUG-48） | 是 | 上游与重试 | 单元测试 |
| #1561 | 智能体：隐藏同一轮内已自行纠正的失败卡（BUG-46） | 是 | 其他逻辑 | 组件测试 |
| #1562 | 上传字节交完后停在 99% 等确认，首页也显示上传百分比；超限图 × 常显（BUG-42、BUG-49） | 是 | 其他逻辑 | 浏览器场景 |
| #1563 | fix(agent): 删项后规则正文张数同步；追问时不把确认前删掉的项当成还缺（BUG-50/51） | 是 | 其他逻辑 | 单元测试 |
| #1564 | 修复项目数额度把回收站算进去、收起那叠总进度往回跳、原因句不按图序（BUG-52/53） | 是 | 计费 | 单元测试 |
| #1565 | 额度满被拒建时不留本机占位项目、首页发送干净收手，超限原因句补句号（BUG-54） | 是 | 本地与云端同步 | 浏览器场景 |
| #1566 | 修复回复里产物链接打开失败、回复与建议句露出批次项 key（BUG-55/56） | 是 | 其他逻辑 | 组件测试 |
| #1567 | 侧栏封面排队或取不到时露出图标，不再是空方块 | 不确定 | 视觉布局 | 组件测试 |
| #1568 | 修复 QA 第一轮体验问题（UX-02/03/04/05/07/08/10/11/12/14/16/17） | 是 | 视觉布局 | 视觉回归 |
| #1570 | 参考区展开时原因句不再在输入框下重复显示 | 否 | 视觉布局 | 组件测试 |
| #1571 | fix(auth): 自助注册接口只收邮箱（UX-09，待私有测试同步） | 否 | 鉴权会话 | 单元测试 |
| #1575 | fix(auth): 手机上注册按钮留在首屏（UX-13，待确认） | 是 | 视觉布局 | 视觉回归 |
| #1579 | 参考图失败原因只说一次并标明第几张；统一 50 MB 提示（BUG-57/58） | 是 | 其他逻辑 | 组件测试 |
| #1581 | 修复快速生成里坏参考图不标红、不拦发送（BUG-59） | 是 | 其他逻辑 | 组件测试 |
| #1582 | fix: 体验测试 R2 修复（双击弹层、排队中进度、手机卡片按钮、注册按钮、#contact、英文 slug） | 是 | 视觉布局 | 浏览器场景 |
| #1586 | fix: 法律页联系入口与落地页假项目地址 | 否 | 视觉布局 | 代码评审 |
| #1587 | fix(bff): 清掉智能体回复里夹带的其他文字 | 是 | 其他逻辑 | 单元测试 |
| #1588 | fix(release): retry a stalled Pages verification request and name it | 流水线 | 流水线部署 | 代码评审 |
| #1591 | 窄屏官网顶栏保持单行（BUG-63、BUG-64） | 是 | 视觉布局 | 视觉回归 |
| #1592 | fix(web,website): 联系弹窗邮箱完整显示，补齐顶栏热区与间距 | 是 | 视觉布局 | 视觉回归 |
| #1593 | 上游生图故障：账号池耗尽即暂停不重试、告警带模型明细与通用 webhook、智能体自动回退可用模型 | 是 | 上游与重试 | 单元测试 |
| #1594 | fix(backup): newest_object 跨分页取最新对象，修复测试站演练报 no completed dump | 流水线 | 流水线部署 | 单元测试 |
| #1595 | fix(web): 项目数到上限时不再卡死在拒建页 | 是 | 其他逻辑 | 浏览器场景 |
| #1596 | fix(web): 对话视图不再同时出现两个资产入口 | 否 | 视觉布局 | 组件测试 |
| #1598 | fix(web): 我的作品删除后刷新又出现——同步删除平台记录 | 是 | 本地与云端同步 | 浏览器场景 |
| #1600 | 修复：容器启动时补跑上次失败的备份恢复演练（冷却 6 小时可配） | 流水线 | 流水线部署 | 代码评审 |
| #1601 | fix: Gemini 429 止损——单张回落 nano-banana-2.1、Lite 每单 4 张、回合内串行、重试保留槽位（BUG-83/84） | 是 | 上游与重试 | 单元测试 |
| #1603 | fix(ops): add safe diagnostics for backup observation failures | 流水线 | 流水线部署 | 代码评审 |
| #1606 | fix: #1601 止损补齐（整批预检、部分交付、总时长上限、2 条 P1） | 否 | 上游与重试 | 单元测试 |
| #1607 | 修复图片生成模式选 Lite 仍能选 6、8 张（BUG-91） | 是 | 其他逻辑 | 组件测试 |
| #1609 | fix: #1606 评审 P1 跟进（检查点缺口校验、结果未知不部分交付） | 否 | 上游与重试 | 代码评审 |
| #1610 | fix(web): 对话页顶栏只留一个资产入口；图片生成模式跨刷新保留、再次生成直出原提示词 | 是 | 刷新恢复 | 浏览器场景 |
| #1623 | fix(web): 按模型系列展示模型选择器 | 否 | 视觉布局 | 组件测试 |
| #1630 | fix(backup): 只保留最新 PostgreSQL 备份 | 流水线 | 流水线部署 | 代码评审 |
| #1633 | fix(deploy): 修正 setup-bun 固定版本 | 流水线 | 流水线部署 | 代码评审 |
| #1634 | fix(db): 迁移会被跳过时直接报错，不再静默漏跑 | 流水线 | 流水线部署 | 单元测试 |
| #1635 | fix(deploy): 后端跳过时收费站 Pages 也能发布 | 流水线 | 流水线部署 | 代码评审 |
| #1636 | fix(ci): 修复 setup-bun action pin | 流水线 | 流水线部署 | 代码评审 |
| #1649 | fix(agent): 批次单张取消只对排队中的那张开放 | 否 | 其他逻辑 | 单元测试 |
| #1650 | fix(web): GPT 会员档位改问服务端，会员不再被误锁在 1K | 是 | 计费 | 组件测试 |
| #1656 | fix(ops): 备份告警线留出一次漏跑的余量 | 流水线 | 流水线部署 | 代码评审 |
| #1657 | fix(ci): 登录页冒烟按后台下发的登录方式逐项对照 | 流水线 | 流水线部署 | 代码评审 |
| #1658 | fix(web): 修复工具箱手机 HEIC 照片导入和导出 | 不确定 | 其他逻辑 | 浏览器场景 |
| #1665 | fix(deploy): 部署锁 owner 原子写入，修复并发双赢 | 流水线 | 流水线部署 | 单元测试 |
| #1666 | fix(web): 在账户菜单显示 CLI 连接入口 | 否 | 其他逻辑 | 组件测试 |
| #1670 | fix(deploy): 撞锁以退出码 75 失败，手工 rollout 也取主机锁（#1276） | 流水线 | 流水线部署 | 代码评审 |
| #1675 | fix(deploy): 部署 key 绑定固定范围，测试 key 只能发布 test（#1275） | 流水线 | 流水线部署 | 代码评审 |
| #1680 | fix(deploy): VPS 只执行固定 runtime，发布包改为纯数据（#1275） | 流水线 | 流水线部署 | 代码评审 |
| #1681 | fix(deploy): 对齐 VPS 纯数据包协议，恢复自动发布 | 流水线 | 流水线部署 | 代码评审 |
| #1687 | 修复后台概览今天窗口的 HTTP 500 | 是 | 其他逻辑 | 单元测试 |
| #1691 | fix(web): 修复 GIF 参数校正循环导致的线上白屏 | 是 | 竞态时序 | 浏览器场景 |
| #1692 | fix(web): 精简插件接入提示词并修正图标选择栏 | 否 | 视觉布局 | 代码评审 |
| #1693 | fix(admin): 恢复生图概览并补齐错误与任务明细 | 否 | 其他逻辑 | 组件测试 |
| #1694 | fix: 提前拦截超限 GIF 拼图并保留产物 MIME | 是 | 其他逻辑 | 单元测试 |
| #1695 | fix(cli): 简化插件授权与生图 Skill 使用流程 | 否 | 其他逻辑 | 代码评审 |
| #1697 | fix: 统一模型能力、Gemini 档位与会员提案估价 | 是 | 计费 | 单元测试 |
| #1698 | fix(web): 同步 CLI 0.1.1 安装入口与插件说明 | 流水线 | 流水线部署 | 代码评审 |
| #1702 | fix(admin): 正确标明 CLI 生成任务来源 | 否 | 其他逻辑 | 单元测试 |
| #1707 | fix(web): 企业单点登录隐藏套餐入口 | 是 | 鉴权会话 | 组件测试 |
| #1708 | fix(admin): 将接口不存在的 404 记录为 WARN | 否 | 其他逻辑 | 单元测试 |
| #1710 | fix(bff): 直连保留原始提示词，仅网关添加防改写前缀 | 是 | 其他逻辑 | 单元测试 |
| #1711 | fix(cli): 修复授权中断重跑与返回应用提示 | 否 | 鉴权会话 | 单元测试 |
| #1712 | fix(web): 插件安装入口同步已发布的 CLI 0.1.3 | 流水线 | 流水线部署 | 代码评审 |
| #1713 | fix(web): 修复账户栏滚动胶囊与控件尺寸 | 否 | 视觉布局 | 视觉回归 |
| #1714 | fix(web): 同步插件安装入口至已发行 CLI 0.1.3 | 流水线 | 流水线部署 | 代码评审 |
| #1716 | fix(web): 启动时不再每次轮换 refresh，修复登录态被误判复用而丢失 | 是 | 鉴权会话 | 浏览器场景 |
| #1717 | fix(web): 配置连接失败时保留登录恢复入口 | 是 | 刷新恢复 | 浏览器场景 |
| #1719 | fix(auth): 修复刷新响应丢失导致的会话误吊销 | 是 | 鉴权会话 | 浏览器场景 |
| #1720 | fix(web): 收紧首页创作区间距 | 否 | 视觉布局 | 视觉回归 |
| #1721 | fix(admin): align console UI with design tokens | 否 | 视觉布局 | 代码评审 |
| #1722 | fix(bff): align Gemini extra image tier with billing (#1699) | 是 | 计费 | 单元测试 |
| #1724 | fix(deploy): 测试与生产撞锁时等待另一环境的 CI 发布结束 | 流水线 | 流水线部署 | 代码评审 |
| #1746 | fix(cli): 服务地址跟随已存连接，冲突时报 SERVICE_MISMATCH (#1726) | 否 | 鉴权会话 | 单元测试 |
| #1747 | fix(cli): 刷新失败如实报错，不再当成未登录 (#1727) | 否 | 鉴权会话 | 单元测试 |
| #1753 | fix(web): 插件安装入口同步已发布的 CLI 0.1.4 | 流水线 | 流水线部署 | 代码评审 |
| #1761 | fix(web): align image tier quotes with membership | 是 | 计费 | 组件测试 |
| #1765 | fix(web): 插件授权页「已连接」不再显示点不动的返回按钮 | 否 | 视觉布局 | 组件测试 |
| #1774 | fix(web): 启动守卫忽略被拦截的第三方脚本，媒体缓存 recency 写入不再漏 rejection | 是 | 刷新恢复 | 浏览器场景 |
| #1775 | fix(admin): 灵感库页签只把当前页标为 current | 否 | 视觉布局 | 组件测试 |
| #1777 | fix(cli): 钥匙串凭据按配置目录分开，另一个目录登录登出不再删掉默认登录（0.2.1） | 否 | 鉴权会话 | 单元测试 |
| #1780 | fix(bff): 开机清理改在后台跑，不再挡着新实例监听 | 不确定 | 竞态时序 | 单元测试 |
| #1781 | fix(cli): images create 出错后仍带任务与已下载文件，同键重跑可续（0.2.3） | 否 | 其他逻辑 | 单元测试 |
| #1784 | fix(bff): 批次提交被拒时按原因暂停，不再停在运行中反复重提 | 不确定 | 其他逻辑 | 单元测试 |
| #1786 | fix(bff): 提示词被审核拒绝的 task.failed 日志降为 warn | 否 | 其他逻辑 | 单元测试 |
| #1788 | fix(web): recover failed lazy route loads | 是 | 刷新恢复 | 浏览器场景 |
| #1789 | fix(web): 保留懒加载错误分类与画布布局 | 否 | 刷新恢复 | 浏览器场景 |
| #1790 | fix(bff): 停用密钥停止重复告警，任务记录实际通道与指纹 | 不确定 | 上游与重试 | 单元测试 |
| #1794 | fix(bff): 拦截聊天短确认语，避免批次出完后又重复生成 | 是 | 其他逻辑 | 单元测试 |
| #1801 | fix(website): 未知页按路径选择语言 | 不确定 | 其他逻辑 | 组件测试 |
| #1803 | fix(bff): Image 2.6 直连不可用时降级走 sub2api | 是 | 上游与重试 | 单元测试 |
| #1805 | fix(bff): Image 2.6 直连不可用时静态图走 sub2api | 否 | 上游与重试 | 单元测试 |
| #1810 | 修复 Image 2.6 崩溃恢复时仍把原档请求发给 sub2api | 否 | 上游与重试 | 单元测试 |
| #1813 | fix(web): 发版后旧标签缺分片时自动刷新一次 | 是 | 刷新恢复 | 浏览器场景 |
| #1814 | fix(deploy): Pages 发布保留最近几版的哈希文件 | 流水线 | 流水线部署 | 代码评审 |
| #1815 | fix(deploy): 软链接路径下保留脚本不再静默跳过 | 流水线 | 流水线部署 | 代码评审 |
| #1816 | fix(agent): 确认门空续跑不再报成本轮失败【涉及结算，需 Nain 亲自审】 | 不确定 | 计费 | 单元测试 |
| #1820 | fix(bff): 设备码兑换必须处于 approved | 不确定 | 鉴权会话 | 单元测试 |
| #1821 | fix(web): Image 2.6 直连不可用时按 sub2api 降级报价 | 否 | 计费 | 单元测试 |
| #1827 | fix(bff): 队列任务终态经 queueTask 写入【涉及结算，需 Nain 亲自审】 | 不确定 | 计费 | 单元测试 |
| #1830 | fix: 作品列表不再收录画布候选图，0 产物完成改为失败退款 | 是 | 本地与云端同步 | 单元测试 |
| #1832 | fix: 画布上传与作品提升不再抢同一张图 | 是 | 竞态时序 | 浏览器场景 |
| #1833 | fix(web): 画布换云地址时不再闪素材缺失 | 是 | 本地与云端同步 | 浏览器场景 |
| #1836 | 修复（计费）：Image 2.5 只按分辨率计价 100/120/150，高画质不加价（涉及结算，需 Nain 亲自审） | 是 | 计费 | 单元测试 |
| #1838 | fix(db): 数字转换先校验再 cast，脏值不再打垮整条查询 | 不确定 | 其他逻辑 | 单元测试 |
| #1839 | fix(bff): 登录或积分打开时拒绝 CORS 通配 | 否 | 鉴权会话 | 代码评审 |
| #1841 | fix(admin): 数据库角色不是只读就拒绝启动 | 否 | 其他逻辑 | 代码评审 |
| #1843 | fix(admin): 任务详情脱敏，日志脱敏移到 shared | 否 | 其他逻辑 | 代码评审 |
