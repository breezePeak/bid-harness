# Agent Note: 将 Bid 工作流准入保留在 Host

Status: implemented

[English](2026-08-29-bid-host-runtime-admission.md) | 中文

## Problem

Bid 浏览器投影曾使用两个键，并通过浏览器入口导出 Host 运行时函数；同时，系统还暴露了没有生产路由的消息、重试和确认操作。因此，Bid Session 可以进入通用提示词路径，在 Host 拒绝不受支持的工作流输入前写入用户消息。

## Decision

`@deepseek-ai/dsh-bid/control-plane` 只导出浏览器安全的常量和类型，`bid.runtime` 是唯一的 Bid 投影键。Bid Host 插件注册该投影，并在 `createUserMessage`、follow-up 或 steer 执行前，根据 Session 解析出的 `bid` preset 拒绝通用提示词准入。在专用操作路由完成前，投影只暴露文件上传，并使用规范原因禁用输入框。Reducer 仅接受当前运行阶段或等待确认的目录确认阶段完成，并忽略其他完成事件。

## Alternatives considered

**保留通用提示词投递并由 Bid Agent 拒绝。** 不采用，因为工作流权限判断前，用户消息已经持久化并对模型可见。

**暴露仅由本地 UI 回调支持的操作。** 不采用，因为投影操作描述的是 Host 能力；没有生产路由的操作会让浏览器获得虚假的权限信息。

**为兼容性注册第二个客户端别名。** 不采用，因为项目尚无已发布的兼容性义务，单一键可避免投影分叉。

## Consequences

生产级 Bid 操作路由实现前，Bid Session 不能使用通用输入框。Standard Session 仍保留通用提示词投递。浏览器代码不再导入依赖 Node 的 Bid 运行时模块，回放也无法通过无关或乱序阶段事件推进状态。
