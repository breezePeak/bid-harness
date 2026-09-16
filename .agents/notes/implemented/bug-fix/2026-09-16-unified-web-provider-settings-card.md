# Agent Note: Web Provider 统一设置卡片

Status: implemented

## Problem

Tavily 是 `ctx.web` 的一个搜索提供方，而不是与网页搜索并列的能力。前端把 Tavily 单独展示成卡片时，用户无法从同一处确认实际执行网页搜索的提供方；原有模型搜索策略卡片中的 Provider 也不等于 Web seam 的实际路由。

## Decision

插件配置页只注册一张以 `web` 为键的网页搜索卡片。基础组合将 `web.searchProvider` 设为 `deepseek-official`，该路由跟随发起任务的模型 Provider；卡片上方的下拉框将它显示为默认的“跟随模型 Provider”，其他已注册 Web Provider 作为显式的独立搜索选项。下方配置区管理独立搜索的连接与检索参数，不将实现提供方呈现为与 Web 搜索并列的设置类别。`web-search-deepseek` 的搜索预算和 `web-search-tavily` 的独立 Provider 参数由该卡片统一暂存、保存和放弃；API Key 继续通过 credentials 写入，密钥值不进入 Settings 响应。

## Alternatives considered

**保留专用 Tavily 设置分区：** 把实现名称当成产品设置类别会暗示 Tavily 与 Web 搜索并列，也无法表达“默认跟随模型，可选独立搜索”的路由关系。

**把 Tavily 选项塞入模型搜索卡片：** 模型 Provider 是 DeepSeek hosted search 的内部策略，不是 `ctx.web` 的通用搜索路由；继续共用该字段会产生界面选择与运行时路由不一致。

## Consequences

Web 设置命名空间由 `WebRuntime` 注册并通过 Host API 暴露无密诊断信息。配置的提供方不可用时，卡片保留其选择并明确标注，不静默切换到其他提供方。跟随模型的搜索预算与独立搜索参数仍保留原有命名空间，以维持各自的 Host 所有权。
