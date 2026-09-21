# Agent Note: Bid 后台 Run 进度闭环

Status: implemented

## Problem

Bid 的阶段执行位于独立 Execution Session，Interaction Session 空闲时不会显示原生 Stop，Main Agent 也只能按阶段读取各自的进度结构。S2、S3、S5 和 S6 缺少统一的有界运行里程碑，浏览器无法持续呈现当前阶段做到哪一步。

## Decision

`BidRunSnapshot` 保存当前 Run 的最新 `BidRunProgress`，进度包含受限的阶段键、摘要、可选真实计数、最多五条短说明和 Host 时间。`BidRunCoordinator.reportProgress()` 只接受活动 Run 的权限，写入 `bid.run.progress`；Reducer 同时校验 runId、epoch 和 stage，只替换最新里程碑。S2–S6 的确定性执行器在定位、生成、校验、修复、审核和导出边界报告里程碑，计数从当前执行日志或已解析产物计算。

每次公开用户请求组装模型输入时，Interaction Agent 读取当前运行或取消中的最新里程碑；没有新请求时不唤醒模型，也不复制 Child transcript、Artifact 正文或工具历史。`bid_stage_inspect` 返回同一份有界进度。终态摘要仍由[Bid Host 终态摘要投递](2026-09-21-bid-host-terminal-update-delivery.md)拥有。

浏览器从 `bid.runtime` 的当前 Run 和 `run.progress.phase` 生成阶段有序计划，并通过 `ui-primitives` 的无 Cordis `PlanListPanel` 呈现；普通 Todo 也以适配器使用该组件，但两者保留各自的数据和生命周期。Bid 不注册 `bid-run` Chat Node，不写入 `todo/write`，`bid.run.*` 事件和最新进度仍用于重放、恢复、Main Agent 上下文及 Host 检查。运行或取消中的 Dock 只显示阶段计划；挂起、失败和需要处理仍显示原因，S4 的任务计数卡仅保留在非运行状态。Execution Session 的成员、数量和导航继续由原生 Subagent UI 呈现。

Conversation 提供按 Session 和 owner 聚合的后台活动注册表。Bid 投影存在 running 或 cancelling Run 时登记停止动作；空草稿主按钮显示原生 Stop 并调用现有 `stopRun`，非空草稿仍按现有 queue/steer 规则发送。该注册表不修改 `session.running`，前台回答与后台阶段执行继续拥有独立生命周期。

## Alternatives considered

**把 Execution Session 标记为 Interaction Session 正在运行。** 这会重新混合两条生命周期，使发送、停止和忙碌状态失去明确所有权。

**把每个里程碑注入 Main Agent inbox。** 没有用户问题时这些消息只会膨胀上下文并可能唤醒模型；请求时读取 latest-only 快照即可回答当前进度。

**让 Bid 直接复用 Workflow UI 插件导出的组件。** UI 插件之间的值依赖会绕过 Slot 边界并要求安装顺序；静态呈现原语才是允许的共享层。

**继续用 Bid Run 卡显示阶段、执行会话和成员三层结构。** S2–S6 的用户问题是当前阶段做到哪一步；执行成员已有原生 Subagent UI，重复展示会把同一阶段拆成两张运行视图。

**向 `todo/write` 写入 Bid 计划。** Todo 在下一次 `turn/start` 清空，无法表达跨用户对话持续的后台 Run；共享纯展示组件可以复用视觉而不混合生命周期。

## Verification

Run coordinator 与控制状态测试固定有界校验、latest-only 重放、过期身份拒绝、终态保留和退休 Run 拒绝；项目 Session 测试固定 S2、S3 的真实标签、inspect 与下一次公开请求输入。阶段执行器测试覆盖报告点。客户端测试固定 Todo 适配器无回归、S1–S6 phase 映射、S3 恢复与修复、运行态单一计划、后台 owner 聚合、空草稿停止和非空草稿发送。

## Consequences

Bid 的运行可见性不依赖 Main Agent 是否正在回答，刷新和事件重放会恢复最新阶段计划。每个里程碑增加一条小型 Session 事件，但控制快照只保存一份最新值；Plan Builder 只投影状态，不保存第二套业务历史，因此恢复 Run 必须报告真实 checkpoint phase。停止后台阶段与停止前台回答仍是两个动作；当 Bid Run 存在时，空草稿主按钮明确归属后台 Run。Interaction/Execution 的隔离和项目写入所有权继续由[Bid 独立交互与执行通道](2026-09-14-bid-interaction-execution-lanes.md)约束，公开聊天规则继续由[Bid 全阶段 Main Agent 交互](../feature/2026-09-11-bid-all-stage-main-agent-steer.md)约束。
