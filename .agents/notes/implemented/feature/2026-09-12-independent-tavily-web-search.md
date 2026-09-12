# Agent Note: 默认独立 Tavily Web Search

Status: implemented

## Problem

基础组合原先把通用 `web_search` 指向聊天 Provider 的 hosted search。聊天路由切换到不提供 hosted search 的 GPT、CPA 或其他兼容 Provider 时，搜索能力随之消失；S4 即使正确保留失败阻断，也无法完成模型主动选择的联网研究。搜索凭据若写入组合、Prompt 或项目产物，还会越过既有 Credentials 与 Settings 所有权。

## Decision

本记录替代[默认 Web search](2026-07-31-web-default-search.md)中由聊天 Provider 提供默认搜索的选择；其通用工具启用、显式 Provider 选择、Host Plane 所有权和网络权限边界仍然有效。

新增 `@deepseek-ai/dsh-web-search-tavily` 实现现有 `ctx.web` Search Provider 契约，稳定 ID 为 `tavily`。基础组合显式选择该 ID；`@deepseek-ai/dsh-tool-web` 继续独占模型可见的 `web_search`，业务插件只看到通用搜索与抓取工具。DeepSeek hosted-search 适配仍可安装和显式选择，但不再决定基础组合的搜索可用性。

Settings 段 `web-search-tavily` 保存端点、超时、搜索深度、主题、摘要模式、结果数和每来源片段数。`apiKeyEnv` 只保存 Credentials 引用名；每次请求通过 Credentials 服务解析当前值，未安装该服务时读取同名启动环境。请求固定关闭 raw content，结果摘要映射到通用 snippet，完整正文仍由 `web_fetch` 获取。凭据不进入 session、Prompt 或 Bid Artifact。

Provider 自身用独立 deadline 约束直接调用：超时为 `WEB_SEARCH_TIMEOUT`，调用方取消为 `WEB_ABORTED`，缺少凭据、认证、网络、HTTP 和响应格式问题为 `WEB_PROVIDER_ERROR`。Web registry 的显式选择规则负责缺失或不可用 Provider 的错误；不回退到聊天模型知识或其他隐式路由。S4 保留 `EVIDENCE_MAPPING_WEB_RESEARCH_BLOCKED`：模型没有选择联网时不强制调用，选择后某类 Web 工具全部失败则拒绝 Research Ready 和 Structure Assessment。

## Alternatives considered

**继续根据聊天 Provider 动态选择 hosted search。** 同一会话的聊天与搜索生命周期仍然耦合，无法保证非搜索聊天路由下的 S4 研究能力。

**在 Bid 插件中直接调用 Tavily。** 这会把供应商端点、凭据和错误分支带入业务阶段，绕过通用 Web Service，也会让其他 Agent 无法复用实现。

**搜索失败后允许模型用已有知识继续。** Session 无法重建声称获得的外部证据，也会把基础设施失败误报成研究充分。

## Consequences

基础组合需要为 `TAVILY_API_KEY` 提供 Credentials 值或启动环境值；缺失时工具保持可发现，但首次搜索明确失败。聊天 Provider 无 hosted-search 能力的集成回归通过真实 `ctx.tools.execute()` 调用 Tavily Provider，并只在 HTTP 边界使用固定响应，证明通用工具路由与 `ctx.llm.supports(provider, 'web_search')` 无关。Provider 单元测试覆盖 Settings 热更新、Credentials 轮换、请求映射、取消、超时和失败分类；带真实密钥的 e2e 可验证公开来源。

默认搜索不等于默认信任任意网页。搜索结果只提供候选 URL 和摘要；需要证据正文的 S4 链路仍须成功 `web_fetch`，并由 Host 保存可重建 Snapshot。独立 Provider 解决执行路由，不证明任何具体项目的目录深化质量；该结论必须来自真实 Workspace 回放和验收报告。
