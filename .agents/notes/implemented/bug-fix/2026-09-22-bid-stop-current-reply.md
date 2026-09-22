# Agent Note: Bid 停止按钮同时取消当前回复

Status: implemented

## Problem

后台 Run 存在时，Composer 的停止按钮调用 `bid.stopRun`。只挂起后台 Run 会让同时进行的主会话回复继续生成，用户无法通过这枚按钮一次停止当前执行。

## Decision

`stopRun` 向发起请求的主 Agent 发出 `user` 取消并保留 inbox，再等待项目停止处理完成。主会话空闲时仍停止后台 Run；同项目其他会话的回复不受影响。Run 的子任务收敛、已完成产物及挂起状态继续由原有停止处理负责。

本记录替代[后台 Run 进度闭环](2026-09-21-bid-background-run-progress.md)中停止按钮仅归属后台 Run 的决定；该记录的进度投影、阶段计划与独立执行通道设计仍有效。

## Alternatives considered

**前端连续调用两个取消接口。** 其他 `stopRun` 调用者仍会保留不完整的停止语义，并增加两个请求之间的竞态。统一在 Host 入口处理可复用现有用户取消事件与项目停止屏障。

## Verification

项目会话测试覆盖普通取消和 Remote 停止：当前回复以 `aborted` 结束，S4 Run 收到取消并挂起，项目操作释放后仍能继续聊天。真实浏览器测试点击后台 Run 的停止按钮并核对主会话结束事件。

## Consequences

前台回复和后台 Run 保持独立生命周期，但用户的一次停止操作作用于两者。保留的排队消息仍遵守会话原有调度规则，停止不清空用户后续输入。
