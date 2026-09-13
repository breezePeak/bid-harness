# Agent Note: Web 搜索跟随任务模型路由

Status: implemented

## Problem

基础组合将 Tavily 固定为 `ctx.web` 的搜索后端，即使任务实际使用的模型 Provider 支持 hosted `web_search`，搜索仍会离开该任务路由。Tavily 仅凭凭据引用名判断可用，也会在缺少实际密钥时参与选择。

## Decision

基础组合固定选择保留兼容 ID `deepseek-official` 的 LLM hosted-search 适配器。该适配器在未显式配置搜索 Provider 时读取发起 Agent 当前请求的 Provider 和模型；显式搜索 Provider 仍覆盖该路由。Web Provider 的可用性检查允许异步读取本地凭据状态，Tavily 只有存在实际凭据时才可被选择。

## Alternatives considered

**删除默认搜索 Provider。** 多个已注册后端会重新触发不确定的自动选择，因此保留 hosted-search 适配器的确定性配置。

**让 Tavily 在搜索失败后回退到模型 Provider。** 这会隐藏认证错误并让实际网络请求偏离用户选择的后端。

## Consequences

“跟随当前任务 Provider”在界面、已保存的空值和请求路由中指向同一行为。Tavily 继续可通过显式 Web Provider 配置使用；其本地凭据状态检查会在选择前异步读取凭据服务，不探测远端账号。
