# 技能效果验证

一条技能只有在固定测试输入、钉死模型下跑出来的图经人工打分过线，`meta.json` 才写
`verified`，起手句才会露出它（#995）。本目录与各技能的 `verification/` 都**不进镜像**
（本目录不在 `.dockerignore` 的放行名单里，各技能的 `verification/` 显式排除），只服务这条流程。

## 目录

```
apps/bff/skill-verification/
  README.md              本文件
  fixtures/*.webp        公共测试素材（商品、人物），多条技能共用，避免重复入库
apps/bff/skills/image/<技能>/verification/
  cases.json             3 组固定测试输入
  *.webp                 这条技能独有的输入图（可选）
  record.json            验证记录：跑图信息 + 评分（打完分后提交）
apps/bff/.verification-runs/<时间>/   跑图产出与对比页（gitignored）
```

图片保持小：最长边 768、webp，单张几十 KB 以内。

## cases.json

```json
{
  "cases": [
    { "id": "mug", "prompt": "用这条素材 {asset1} 出一张主图", "inputs": { "asset1": ["shared:product-mug.webp"] } }
  ]
}
```

- 正好 3 组，`id` 用 kebab-case。
- `inputs` 的键是技能 `meta.json` 声明的素材位 key；预置模板没写 `inputs` 时是 `asset1..N`（按 `slotCount`）。必填位不能缺，单图位只放一张。
- 图片写文件名：`shared:<文件>` 取本目录的 `fixtures/`，不带前缀取本技能 `verification/` 目录。
- `prompt` 是用户那一句话，不带 `/技能名`；每个给了图的位都要以 `{key}` 出现在句子里，发出时换成 `[image N]`。

格式由 `src/__tests__/lib/agent/shipped-skills.test.ts` 校验。

## 流程

1. **跑图（macmini2，不在本机跑批）**。每组跑 2 次，模板用钉死的模型，普通技能用部署默认模型：

   ```bash
   rmake -c 'cd apps/bff && bun run skills:verify:run --skills look-clean-studio,look-material-detail'
   ```

   需要的环境变量（写在 macmini2 的 `apps/bff/.env.local`，bun 会自动读）：

   | 变量 | 说明 |
   | --- | --- |
   | `SKILL_VERIFY_BFF_URL` | 要验证的 BFF API 地址 |
   | `SKILL_VERIFY_SESSION` | 登录会话 cookie `image_playground_session` 的值（开计费的部署必填，跑图会扣这个账号的积分） |
   | `SKILL_VERIFY_DEVICE_ID` | 可选，匿名设备 ID |

   其余参数：`--runs 2`、`--cases mug`（冒烟只跑一组）、`--mock`（不连 BFF，走一遍流程，产出图就是输入图）。
   脚本走与浏览器相同的智能体接口：新开会话 → 以出图模式发 `/技能名 …` 并附参考图 → 等轮与后台任务收尾 → 取最后一张成功产出的图。

2. **打分**。打开 `.verification-runs/<时间>/review.html`（`bun run skills:verify:review [目录]` 可重新生成），每张图按三项各打 1–3 分：

   - 主体保真：商品 / 人物有没有走样（外形、颜色、标识、比例）
   - 效果符合描述：是不是做成了这条技能说的那种图
   - 无明显瑕疵：畸形、乱码文字、穿帮、多出来的东西

   **过线**：6 张的主体保真都 ≥ 2，且全部分数平均 ≥ 2.5；6 次须是同一个模型。页面上的「当前判定」与回填工具用同一个判定函数（`src/lib/skill-verification/record.ts`）。

3. **导出与回填**。点「导出验证记录」，把文件存为 `image/<技能>/verification/record.json`，然后：

   ```bash
   cd apps/bff && bun run skills:verify:backfill look-clean-studio
   ```

   过线写入 `meta.json` 的 `verified: { date, model, score }`；不过线删掉 `verified` 并打印原因。
   `record.json` 与 `meta.json` 一起提交；发布测试会核对二者一致。

钉死的模型一改，`verified.model` 就与当前模型对不上，技能自动从起手句下线，重新跑这条流程即可。
