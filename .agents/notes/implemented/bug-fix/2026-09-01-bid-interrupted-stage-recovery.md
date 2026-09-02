# Agent Note: Bid 中断恢复与当前阶段重置

Status: implemented

## Problem

Bid 阶段开始时会持久化 `bid.stage.started`，但 Host 进程在 Executor 或 Validator 结束前停止时无法写入完成或失败事件。Session 恢复后只能归约出 `running`；新进程中没有对应的执行操作，Projection 却仍禁用操作区并要求用户等待，因此项目无法继续。

## Decision

`BidOrchestrator.drive()` 把“新 Orchestrator 实例没有进程内 operation，但 Session 日志归约为 `running`”视为上一个 Host 进程的中断执行。它在运行任何 Executor 前追加当前阶段的 `bid.stage.failed`，并保持既有失败恢复语义：S1 允许重新上传，其他阶段允许通过 `bid/retryStage` 完整重跑。`agent/session-start` 会调用该 `drive()` 并刷新 Session，所以恢复结果是持久事实，而不是浏览器推测。

同一 Orchestrator 上的并发 `drive()` 仍共享已安装的 operation，不会把真正在执行的阶段标记为中断。恢复处理不接管部分 Artifact；后续重试仍由各阶段 Executor 按其完整执行入口处理旧的尝试输出。

Bid Preset 在 Agent 作用域注册 `/bid-reset-s2` 至 `/bid-reset-s7`。命令只在目标等于当前阶段且 Host per-Session 操作槽空闲时追加 `bid.stage.reset`，再通过正常 `drive()` 完整重跑该阶段。S5 在记录重置前删除 `draft.json`、`confirmed-outline.json` 和 `confirmation.json`，使目录确认从 S4 产物重建草稿。命令生命周期和重置事件都写入 Session，但命令文本不进入模型历史。

## Alternatives considered

**保持 `running`，由用户发送普通消息恢复。** Bid Host 会拒绝通用 Prompt，而且上一个进程的 Promise、Agent 等待和 Child Session 调度状态无法在新进程中继续。

**恢复时自动重跑当前阶段。** 不采用，因为进程停止可能留下部分 Artifact 和已发起的外部工作；先持久化明确失败再由用户重试，不会把中断误报为新的成功执行。

**只在浏览器把长时间 `running` 显示为可重试。** 不采用，因为多个 Client 会产生不同的超时判断，Session 日志仍然保留错误的运行状态。

**用一个带阶段参数的全局重置命令。** 不采用，因为它会在非 Bid Session 中暴露无效能力，并允许用户输入与当前状态无关的阶段名。作用域内的固定命令让菜单直接展示可用阶段，Host 仍校验目标必须是当前阶段。

## Consequences

Host 重启后，中断的 Bid 阶段会稳定进入 `failed`，页面可重新上传、使用通用重试，或从 `+` 命令菜单重置 S2–S7 的当前阶段，不会无限停留在“正在处理”。该选择不尝试从阶段中间续跑，因此重置会重复当前阶段的必要计算，但保留日志的单一权威和各 Executor 现有的清理责任。单元测试覆盖归约、命令目录和处理器，Host 组合测试覆盖 `agent/session-start` 与重置后 Executor 重入。
