# WorkBuddy CLI + Skill 接入核对

核对时间：2026-11-06；实机 WorkBuddy 5.9.3。

## 官方支持的安装方式

- [技能使用说明](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Skills-Market)：自建包通过「添加技能 → 上传技能」导入；对话查找安装针对技能市场，不能据此宣称未上架技能已安装。导入后要在已安装列表确认启用。
- [技能包结构](https://open.workbuddy.cn/docs/skill)：ZIP 内为技能目录，根文件 `SKILL.md`；补充资料放 `references/`。WorkBuddy 还定义了展示名、双语介绍、版本和作者字段。
- [权限说明](https://www.codebuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Permission-Modes)：默认权限以工作空间为边界，写入敏感路径、文件替换与删除可能需要确认。前台执行不等于自动免于权限保护；完全访问会影响全部任务，不作为幕芽接入要求。

## 当前幕芽缺口

CLI 0.1.3 的 `skill install --host` 只接受 `claude-code`、`codex`。旧指南对 WorkBuddy 跳过技能安装，造成账号可用但 `/mu` 没有幕芽技能的体验。本机 `~/.workbuddy/skills` 也没有 `muvloom`，不能将 CLI ready 当作技能已安装。

## 本次方案

继续使用原生 CLI。Web 构建从现有 CLI Skill 源生成 WorkBuddy ZIP，补充其官方元数据和针对实际故障的接入说明；不维护第二份生图工作流，也不添加未经支持的 CLI host 参数。

WorkBuddy 页面使用专用指南和技能包下载入口。完成条件为技能可见且启用、CLI ready、capabilities 成功。认证在可交互前台执行，发码后交回用户操作；写入失败先处理必要权限，状态已 ready 时保留连接。Agent 不手工操作凭据、不修改全局保护。

依据实际日志，本机后台认证曾在最终凭据 rename 时被拒绝；后续前台确认后 CLI 0.1.3 已 ready。早先有服务端签发记录的三次失败不能归因为「无人确认导致过期」。
