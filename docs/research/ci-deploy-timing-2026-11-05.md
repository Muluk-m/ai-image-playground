# CI 与发布耗时：2026-11-05

## 实测基线

以下均为 GitHub Actions API 的 job/step 起止时间，单位为秒。总耗时包含调度、排队和串行依赖，不能把并行 job 耗时相加。

| 运行 | 总耗时 | 主要耗时 |
| --- | ---: | --- |
| [Deploy production #884](https://github.com/Muluk-m/ai-image-playground/actions/runs/41965703828) | 429 | 构建及推镜像 269；VPS 接收与排空 54；Admin job 58 |
| [Web checks #4031](https://github.com/Muluk-m/ai-image-playground/actions/runs/41965745304) | 263 | 首个 job 等待 84；public build job 138；CLI Intel Mac job 143，最后结束 |
| [Web checks #4032](https://github.com/Muluk-m/ai-image-playground/actions/runs/41966177507) | 205 | public build job 136；CLI Intel Mac 等待 distribution 后 52 才启动，运行 124，最后结束 |
| [Web checks #4033](https://github.com/Muluk-m/ai-image-playground/actions/runs/41966290255) | 254 | 首个 job 等待 42；bff 2/3 比 prior 完成晚 95 才启动，运行 113，最后结束 |

#4031 的失败来自 lint，不代表测试执行了 263 秒。修正后的 #4033 全绿，仍有明显排队。
#4030 合并后同树复用已生效，只花 7 秒；无需再实现一套合并后跳过检查。

生产 #884 实际依次构建 qlj（`internal`）、muvloom（`paid`）、backup、segmenter 镜像。qlj 镜像从 04:07:10 UTC 开始到 04:09:21 推送结束，随后才构建 muvloom 镜像，虽然 rollout 只使用 muvloom。
qlj 镜像的约 131 秒并非全部可省：其中一些依赖层会被 muvloom 镜像复用。停止 qlj 构建能移除其独有的前端构建与镜像导出推送，节省量以发布实测为准。

CI #4032 的 public build：安装 workspace 16、Web 构建 52、浏览器步骤 62。后者包括 apt 缓存校验、安装 Chromium、冒烟脚本自身回归和真实构建启动验收；不能将 62 秒全部算作下载。现有 pnpm、Go、apt 与 Docker 缓存已有命中。

## 本次改动

1. 生产调用 `build-vps-release.sh paid`。保留 backup、segmenter、镜像 digest、锁、迁移、排空、API 版本门禁和上线验收。
2. Web checks 根据 Git diff 判断 CLI 输入：Go 模块（含内嵌 Skills、安装器、构建脚本）、CLI workflows、Web workflow、共享 actions、判断器及其测试、根 Go workspace 配置。其它应用的 lint、typecheck、测试、构建和浏览器冒烟照常运行。
3. PR 从 merge base 比较到 PR head；push 比较 before 到 after，覆盖同次 push 的全部提交。禁用 rename 折叠，避免从 CLI 移出文件时漏检。未知事件、无效 SHA、缺失历史、diff 错误和手动验证都运行全部 CLI 检查。CLI 标签发布仍无条件复用完整五平台校验。

目标是减少无用工作与占用的 runner 数量，不增加测试分片，也不放松测试或部署门禁。无用户可见影响，无模型调用成本变化。

## 验证与后续衡量

- 新增 CLI 判断行为测试，覆盖路径分类、PR/push 范围、异常回退和真实 Git rename。
- 新增 muvloom（`paid`）构建回归，确认 `images.tsv` 只包含 `paid`、`backup`、`segmenter` 三种 edition，且保留 overlay、版本及缓存参数。
- 在工作分支手动跑 Web checks，执行 Biome 修复、lint、typecheck、公开/overlay 测试与构建；手动触发保留完整 CLI 矩阵。
- PR 与合并后关注实际 job、队列等待和生产镜像构建耗时。此次 PR 本身改了 Web workflow 与判断器，CLI 会全跑；后续普通 Web/BFF 改动才体现跳过收益。
- 暂不改浏览器运行时或并行发布拓扑。若剩余瓶颈仍是构建，再单独评估 Docker 前后端构建输入隔离和复用已验证产物，避免把后端兼容性与前端发布顺序混入本次优化。
