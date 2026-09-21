# Agent Note: Bid 后台 Run 进度闭环

Status: implemented

## Problem

Bid 的阶段执行位于独立 Execution Session，Interaction Session 空闲时不会显示原生 Stop，Main Agent 也只能按阶段读取各自的进度结构。S2、S3、S5 和 S6 缺少统一的有界运行里程碑，浏览器无法在同一条会话记录中持续呈现当前 Run，用户也无法从该记录打开真实执行会话。

## Decision

`BidRunSnapshot` 保存当前 Run 的最新 `BidRunProgress`，进度包含受限的阶段键、摘要、可选真实计数、最多五条短说明和 Host 时间。`BidRunCoordinator.reportProgress()` 只接受活动 Run 的权限，写入 `bid.run.progress`；Reducer 同时校验 runId、epoch 和 stage，只替换最新里程碑。S2–S6 的确定性执行器在定位、生成、校验、修复、审核和导出边界报告里程碑，计数从当前执行日志或已解析产物计算。

每次公开用户请求组装模型输入时，Interaction Agent 读取当前运行或取消中的最新里程碑；没有新请求时不唤醒模型，也不复制 Child transcript、Artifact 正文或工具历史。`bid_stage_inspect` 返回同一份有界进度。终态摘要仍由[Bid Host 终态摘要投递](2026-09-21-bid-host-terminal-update-delivery.md)拥有。

浏览器将 `bid.run.started`、`bid.run.progress`、取消和终态事件折叠为以 runId 为键的一张持久运行卡。卡片显示真实 Execution Session，阶段变化通过最新 `subagent/descriptor` 更新其标签；点击成员只打开能够证明属于当前 Interaction Session 的真实执行子会话。运行卡与 Workflow 运行视图共用 `ui-primitives` 的无 Cordis 呈现组件，两个 UI 插件不互相导入实现。

Conversation 提供按 Session 和 owner 聚合的后台活动注册表。Bid 投影存在 running 或 cancelling Run 时登记停止动作；空草稿主按钮显示原生 Stop 并调用现有 `stopRun`，非空草稿仍按现有 queue/steer 规则发送。该注册表不修改 `session.running`，前台回答与后台阶段执行继续拥有独立生命周期。

## Alternatives considered

**把 Execution Session 标记为 Interaction Session 正在运行。** 这会重新混合两条生命周期，使发送、停止和忙碌状态失去明确所有权。

**把每个里程碑注入 Main Agent inbox。** 没有用户问题时这些消息只会膨胀上下文并可能唤醒模型；请求时读取 latest-only 快照即可回答当前进度。

**让 Bid 直接复用 Workflow UI 插件导出的组件。** UI 插件之间的值依赖会绕过 Slot 边界并要求安装顺序；静态呈现原语才是允许的共享层。

**继续只显示 S4 专用进度卡。** 它不能覆盖 S2、S3、S5、S6，也不能表示一个 Run 的稳定身份和真实 Execution Session。

## Verification

Run coordinator 与控制状态测试固定有界校验、latest-only 重放、过期身份拒绝、终态保留和退休 Run 拒绝；项目 Session 测试固定 S2、S3 的真实标签、inspect 与下一次公开请求输入。阶段执行器测试覆盖新增报告点。客户端测试固定同一运行节点更新、启动失败终态、真实执行会话导航、后台 owner 聚合、空草稿停止和非空草稿发送。

## Consequences

Bid 的运行可见性不再依赖 Main Agent 是否正在回答，刷新和事件重放会恢复同一张卡及最新进度。每个里程碑增加一条小型 Session 事件，但控制快照只保存一份最新值。停止后台阶段与停止前台回答仍是两个动作；当 Bid Run 存在时，空草稿主按钮明确归属后台 Run。Interaction/Execution 的隔离和项目写入所有权继续由[Bid 独立交互与执行通道](2026-09-14-bid-interaction-execution-lanes.md)约束，公开聊天规则继续由[Bid 全阶段 Main Agent 交互](../feature/2026-09-11-bid-all-stage-main-agent-steer.md)约束。
