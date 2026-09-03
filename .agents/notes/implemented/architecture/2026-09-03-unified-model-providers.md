# Agent Note: 统一模型 Provider 与搜索策略

Status: implemented

## Problem

聊天已有 LLM 路由注册表与按请求解析的凭据机制，但网页搜索单独拥有 DeepSeek 连接配置。默认模型也已有独立的持久化服务，模型页缺少直接编辑该全局选择的入口。父 Agent 的请求模型可不同于创建选项，子 Agent 仅继承创建选项会分裂同一任务的模型选择。

## Decision

扩展现有 `LlmRuntime`，不建立第二套 ProviderManager。`generate` 复用 `stream` 的消息与错误协议，`supports` 查询已安装能力，Provider 通过 `registerWebSearch` 贡献辅助搜索。默认模型仍由 `agent-default-model` 管理，模型页在同一次 settings mutation 中保存 Provider/model 并清除旧 reasoning effort。

`llm-pi-ai/gpt` 固定注册 GPT 路由，复用 pi-ai 的 Responses 消息、函数工具、SSE、usage、reasoning/replay 和取消转换；CPA 只是它的 Base URL。DeepSeek 的聊天和 Anthropic hosted-search 传输集中于 `llm-deepseek`，保留原协议与来源映射。

搜索插件保留历史包名、namespace 和 web 注册 ID，实际按照任务 Provider 或显式搜索策略路由。新配置只含 Provider 选择与预算。旧连接在首次搜索前迁入 `llm-deepseek.search`，先持久化目标再删除旧 user 层，保留不同于聊天的旧凭据。没有可写 settings 的旧静态组合需要部署方移动字段，不会静默忽略。

一次性与可继续子 Agent 继承父级已记录的请求 Provider/model，可继续描述符保存相同捕获值。独立 SDK 子进程也继承已记录的模型选择，保留显式 Provider/model 成对覆盖；子进程凭据仍由自己的组合提供，缺少 Provider 明确失败。搜索只产出结构化来源，抓取原文、持久化证据和 provenance 校验保持原工具与业务职责。

## Alternatives considered

**新建通用 ProviderManager 和 DeepSeek SDK。**现有 LLM 注册表及 DeepSeekAdapter 已承担调用、工具、错误、重试和取消，新体系会产生两套配置与调用入口。

**将 GPT 实现为 Chat Completions 或增加 CPAProvider。**会丢失所需的 Responses hosted-search 协议，或把同协议的部署地址变成业务分支。

**网页搜索继续保存独立密钥。**使模型页的保存与轮换无法覆盖搜索。迁移仅把旧覆盖归入 Provider，新搜索策略不保存凭据。

**直接把 hosted-search 生成答案作为 Evidence。**缺少可审计的抓取正文，无法满足既有 search/fetch provenance 规则。

## Consequences

DeepSeek 保持默认；GPT 未配置密钥不会阻断 DeepSeek 请求。Provider 配置独立，正在执行的请求保留解析时的连接，任务与子任务保留确定的 Provider 选择。能力目录不是远端探测结果；CPA 不兼容 Responses 或 hosted search 时直接报错，不切换模型。

旧 namespace 迁移没有跨 namespace 事务，采用可重试的先写后删。迁入 Provider 的旧搜索专用凭据可能与聊天凭据不同，作为兼容覆盖保留并按 secret schema 脱敏。

真实 Loader 场景位于 [示例配置](../../../../examples/headless-agent/tests/fixtures/web/web-search-deepseek/cordis.yml)，回归使用真实 Agent/Tools/Provider 和本地 HTTP 响应，覆盖工具回传、搜索与读取、子 Agent、配置重启及错误脱敏。现有标书证据映射回归继续校验业务链。真实 OpenAI/CPA 账号权限和外网结果不由这些无密钥回归证明。

本文部分扩展 [默认网页搜索](../feature/2026-07-31-web-default-search.md) 的模型连接归属，以及 [插件配置页面](../feature/2026-08-10-web-plugin-configuration.md) 的搜索卡字段；两者的默认工具启用与分层、显式保存设计继续保留。
