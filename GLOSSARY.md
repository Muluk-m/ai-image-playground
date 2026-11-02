# Muvloom

本词汇表记录 Muvloom 创作、对外 CLI 与 Agent Skill 语境中的产品术语，避免把生成结果、可复用素材和认证凭据混为一谈。

## 对外接入

**CLI API 凭据**：
CLI 访问 Muvloom 对外 API 的独立凭据，与网站 Cookie 会话分开；它代表用户授权的 CLI 连接，可被单独撤销。实现上由 Device Flow 换出短期 access token，并配套可轮换的 refresh token；不是用户手动创建或粘贴进对话的上游 API key。
_Avoid_: 网站 Cookie、上游 API key、用户粘贴进对话的密钥

**Agent Skill**：
遵循行业 Agent Skills 规范的 `SKILL.md` 流程指引，负责指导 Agent 何时及如何使用 Muvloom CLI；它不是生成工具、不是第二套 API 客户端，也不替代 CLI 的凭据存储。
_Avoid_: 插件、工具、prompt 模板

## 创作与媒体

**产物（artifact）**：
一次生成或工具调用交付的一件结果，图片和视频都属于产物。CLI 生成的结果首先是产物，类似快速生成模式下方罗列的作品；只有用户明确要求保存为素材时，才会成为素材的一部分。
_Avoid_: 素材、资产、附件

**素材（asset）**：
用户明确保存、可复用的一组主体参考图及其描述；一次生成得到的产物不会自动成为素材，除非用户主动保存。
_Avoid_: 产物、生成结果、素材图

**参考媒体（reference media）**：
一次生成请求使用的图片媒体，可来自本地上传或已有媒体；它只是该请求的输入，不因被引用就成为素材。
_Avoid_: 素材、产物、资产
