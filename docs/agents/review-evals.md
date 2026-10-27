# 评审回放集（review evals）

线上出过事、最后被 revert 的 PR，是检验 AI 评审有没有用的现成考题：评审当时本该指出的问题是已知的。
改 ocr（`.github/workflows/ai-review.yml`）的**模型、提示词（`REVIEW_GUIDANCE`、REVIEW.md 背景）或评审力度（`OCR_EFFORT` / `LLM_EXTRA_BODY`）之前**，
先用改动前和改动后的配置各回放一遍下面的题目并记录结果，再决定要不要改。没回放、没记录的，不改。

回放会花 `CI_LLM_API_KEY` 的额度（第 5 题很大），跑之前先跟 Nain 说一声。2026-10-27 的第一次回放是 Nain 同意额度后跑的，结果见「记录」。

## 题目

时间为 UTC+8。区间是原 PR 合并进 main 那一刻的变化：`from` 是合并前的 main，`to` 是合并提交（squash 合并时就是那个提交）。

| # | 原 PR（合并时间） | revert（合并时间） | from → to | 规模 |
|---|---|---|---|---|
| 1 | #1166 节点画布骨架（2026-10-11 19:50） | #1167（2026-10-11 21:24） | `e2bfdba83012c651b1d38456ddebe272cc77dbed` → `0ff43cf2dae975a0d19f0e550288d4d3e03cb86d` | 18 个文件，+1327/−79 |
| 2 | #1248 cloudflared 期间保持 admin 可达（2026-10-14 13:00） | #1260（2026-10-14 16:17） | `8a1a69972f62a7da0968b894875a10fce968296a` → `20f4e7b632b3eae5346babdc11b005faaeeac938` | 5 个文件，+786/−11 |
| 3 | #724 补上会员卡要的 TierBadge 与 PrivateMembership（2026-09-22 07:41） | #725（2026-09-22 07:48） | `17f771e814b7f39c39c0c27790552e56248ac9fe` → `61a2e503c1607d29b990aaee6084a06c9cd9fde2` | 2 个文件，+78 |
| 4 | #668 重做作品落地页、由入口决定生成类型（2026-09-19 17:16） | #670（2026-09-19 17:45） | `78d498af871c3ecebd50e39e42d0bb20af464b9d` → `7466cda99d8651edbf15d069e7d8c96dcd068f72` | 29 个文件，+372/−385 |
| 5 | #32 能力、计费与部署整体改造（误合进 main，2026-08-15 00:18） | #40（2026-08-15 00:36） | `5423e17dca0ceaa6d6b858cfa2e61a3a58e1ec50` → `9c46215123c00209863aa7c023226075956d6d19` | 251 个文件，+18329/−4476 |

### 评审本该看出什么

1. **#1166 → #1167，生产白屏。** 新引入 `@xyflow/react`（依赖 zustand），vite 的 `manualChunks` 把 react-vendor 与 zustand 拆成两个块后形成循环导入，生产首页白屏（`TypeError`，设置 `Activity` 时报错）；开发模式不复现。评审应当指出：新增依赖改变了分块，`manualChunks` 有循环风险；要求在测试环境跑生产构建冒烟（[关键流程证据](../../AGENTS.md)）后再合并。功能藏在 `canvas:nodes` 开关后面不等于没风险——打包是全局的。
2. **#1248 → #1260，发布失败但不回滚。** 新加的 admin 代理会在 BFF 已经切到新版本之后才失败，发布中断却不把 BFF 退回去，留下半新半旧的状态。评审应当指出：发布步骤的失败顺序和部分完成状态没有处理，失败路径缺测试。
3. **#724 → #725，收费代码进了公开树。** 只给付费版用的组件放进了公开仓库，违反 [双版本隔离](../dual-edition-isolation.md) 第 (i) 条；正确做法是改私有 overlay（overlay PR #35）。评审应当指出：付费专属代码出现在公开树。
4. **#668 → #670，大的界面与行为改动没经确认。** revert 说明没写原因。#668 去掉了图片/视频切换、改了 `composerStore` 的模式，是用户能感知的行为变化。评审应当指出：需要 Nain 确认（[发布手册](release.md)审批表），并附测试环境截图。
5. **#32 → #40，合错分支。** 本该合进 `test` 的整体改造被误合进 main。评审应当指出：base 分支不对，251 个文件的巨型 PR 不该直接进 main，应拆分或先走测试环境。这一题主要考评审会不会看 PR 的目标分支与规模，ocr 只看 diff，大概率看不出；记录时如实写。

## 怎么回放

在 Actions 页手动运行 **AI Code Review**（`workflow_dispatch`），或用 gh：

```sh
gh workflow run ai-review.yml --ref <要测的配置所在分支> \
  -f from_sha=<from> -f to_sha=<to> \
  -f effort=<留空用工作流默认> -f model=<留空用 LLM_MODEL> -f extra_body=''
```

- `--ref` 决定用哪一版工作流和提示词：测改动前的配置用 `main`，测改动后的用改动所在的分支。REVIEW.md 背景也取自这个 ref。
- 手动运行跳过「Post review results」，不发 PR 评论，也不把意见写进 Job Summary（Summary 里只有耗时统计）。评审意见在该次运行「Run OpenCodeReview」步骤日志末尾 `----- ocr stdout (json) -----` 之后的 JSON 里，含全部级别（不按 `MIN_SEVERITY` 过滤）。日志会过期，记录时把命中的那几条意见原文摘进下面的表格或附在 PR 里。
- 第 5 题很大，可能撞上 `OCR_GROUP_TIMEOUT`；超时的组照实记录为超时。
- ocr 会跳过只改 `.md` 的区间，以上题目都含代码，不受影响。

## 记录

每次回放在下面追加一行，链接到对应的 Actions 运行。「命中」指 JSON 结果里有一条意见明确说中了上面「本该看出什么」的要点（级别也写上）。

| 日期（UTC+8） | 配置（ref@SHA、模型、effort） | 题 1 | 题 2 | 题 3 | 题 4 | 题 5 | 运行链接 | 结论 |
|---|---|---|---|---|---|---|---|---|
| 2026-10-27 19:56 | `main@3e6b01d57`（改 medium 之前的配置，没有 REVIEW.md 背景）、`gpt-6.1-sol`、low | 未命中 | 部分命中（P1） | 未命中 | 未命中 | 未命中 | [1](https://github.com/Muluk-m/ai-image-playground/actions/runs/40499890840) [2](https://github.com/Muluk-m/ai-image-playground/actions/runs/40499900157) [3](https://github.com/Muluk-m/ai-image-playground/actions/runs/40499909592) [4](https://github.com/Muluk-m/ai-image-playground/actions/runs/40499918841) [5](https://github.com/Muluk-m/ai-image-playground/actions/runs/40499927733) | 5 题命中 0 题、部分命中 1 题。low 能挑出代码层面的 bug，但看不出依赖/打包风险、双版本边界和「要不要 Nain 确认」这类流程问题 |

### 2026-10-27 low 回放明细

每题一次，五个运行同时开跑。token 取自各运行 Summary 的 ocr 耗时统计；网关按 token 计费，单价以网关账单为准，这里只记用量。

| 题 | 运行 | 耗时 | 意见数（P1/P2，含 critical/high/medium/low） | 输入 / 输出 token | 本该看出 | 实际说了什么 |
|---|---|---|---|---|---|---|
| 1 #1167 | [40499890840](https://github.com/Muluk-m/ai-image-playground/actions/runs/40499890840) | 6.1 分 | 5（全 P1） | 411,254 / 16,159 | 新依赖改变分块，`manualChunks` 循环导入，要求生产构建冒烟 | 5 条都在画布组件内部：video cleanup 打断播放、i18n 复数 key 不匹配、忽略 `mediaId`、`onInit` 时容器尺寸为 0、标注层级。`apps/web/package.json` 在评审组里，但没有一条提到新依赖对打包的影响。**未命中** |
| 2 #1260 | [40499900157](https://github.com/Muluk-m/ai-image-playground/actions/runs/40499900157) | 3.4 分 | 2（P1） | 128,646 / 8,506 | 失败顺序与部分完成状态：BFF 已切新版后 admin 代理失败，不回滚 | `rollout-runtime.sh:751`：失败时新 Admin 容器不在 `created` 里、`restore` 不停它、`admin-pending` 已写入，会遗留实例；`:669`：只看 worker 数判断 reload 成功，没确认流量到了新 upstream。说中了「失败路径留下半完成状态」，但没点出 BFF 已经切换、整次发布不回退。**部分命中（P1）** |
| 3 #725 | [40499909592](https://github.com/Muluk-m/ai-image-playground/actions/runs/40499909592) | 3.0 分 | 2（P2） | 39,380 / 2,604 | 付费专属代码进了公开树 | 只有 `TierBadge` 的 `aria-label` 和 `size` 校验两条 P2。**未命中** |
| 4 #670 | [40499918841](https://github.com/Muluk-m/ai-image-playground/actions/runs/40499918841) | 3.4 分 | 5（3 P1、2 P2） | 434,344 / 12,480 | 用户可感知的行为改动要 Nain 确认、附测试环境截图 | 抓到了真问题：首屏在云端记录加载前误判为空导致布局跳动（P1）、图片未预留高度（P1）、分类失效后永久骨架（P1）；另有重复配置、死导入。没有提到需要确认或截图。**未命中**（要点），代码层面有收获 |
| 5 #40 | [40499927733](https://github.com/Muluk-m/ai-image-playground/actions/runs/40499927733) | 15.3 分 | 60（critical 1、high 26 等） | 4,868,648 / 116,814 | base 分支不对、巨型 PR 不该直接进 main | 60 条，覆盖鉴权、CORS、XSS、迁移、计费原子性等，没有一条说 PR 太大或该先进 `test`；ocr 只看 diff，在意料之中。没有组超时。**未命中** |
| 合计 | | | 74 | 5,882,272 / 156,563 | | |

第 5 题一题就占了约 83% 的输入 token。以后只想比较配置时，可以先跑 1–4 题，第 5 题单独决定。

### 建议：medium 对比回放（未跑）

本次只按要求跑了 low。PR 把默认改成 medium，按「改评审力度之前先回放」的规则，合并前最好在改动分支上用 medium 再跑一遍 1–4 题（`--ref ci/review-hardening`，会带上 REVIEW.md 背景），看题 1/3/4 有没有变化。预计用量约为本次 1–4 题的 2 倍：输入约 200 万 token、输出约 8 万，耗时每题 5–12 分钟。第 5 题对比价值低、用量大，建议不跑。要不要跑，由 Nain 决定。

## 新增题目

每次 revert PR 或紧急回滚（[发布手册「五、回滚」](release.md)）都在「题目」里加一条：原 PR 与合并时间、revert 与合并时间、`from → to`、规模，以及评审本该看出什么。
