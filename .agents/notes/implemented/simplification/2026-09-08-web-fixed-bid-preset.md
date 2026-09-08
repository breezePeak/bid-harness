# Agent Note: Web 固定使用标书模式

Status: implemented

## Problem

标书 Web 交付只处理技术标，但首页预设选择器和设置中的 Agent 预设页面仍提供其他组合。它们不能服务当前产品流程，并要求用户在开始会话前作出无效选择。

## Decision

`dsh-web-app` 将新会话的默认 agent preset 固定为 `bid`，且不装载 `ui-agent-preset`。首页不显示预设选择器，设置不显示 Agent 预设页面；新建会话直接运行标书控制平面。

预设服务、其他随附组合和预设创作能力继续保留，供明确装载其客户端插件的部署使用；复制式创作的行为由[仅复制的 preset 创作](2026-08-08-copy-only-preset-authoring.md)说明。

## Alternatives considered

**保留选择器但默认选中标书模式。** 未采用，因为仍会展示当前产品不支持的会话入口。

**删除全部非标书 preset 和预设服务。** 未采用，因为其他部署和测试仍可明确使用这些组合；Web 装配取消入口已经满足产品范围。

## Consequences

Web 新会话直接进入标书模式，用户不能在首页或设置中改选预设。网页端到端测试固定默认 preset，并验证两处入口均未装载；标书场景不再通过预设选择器切换会话。
