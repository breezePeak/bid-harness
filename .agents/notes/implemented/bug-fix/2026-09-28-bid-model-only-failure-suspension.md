# Agent Note: 区分模型修复挂起与执行器失败

Status: implemented

## Problem

能力任务中的子代理完成多个回合后仍未提交结构化结果，错误在能力任务边界丢失问题码。Host 将它记为 `executor_error` 并归类为 `blocked`，主 Agent 无法接管。真正的程序、输入和基础设施错误也沿用同一个挂起状态，误导用户把无法通过模型修复的故障当作可继续的模型任务。

## Decision

本记录的非模型错误结算规则由[Bid Host 持续恢复内部失败](2026-09-28-bid-host-recovery-continuation.md)替代；以下保留原决策的边界与取舍。

能力任务保留 `BidStageExecutionError` 的结构化问题，S4 子代理未调用 `finish_mapping_task` 的失败归入模型修复。Host 仅对可修复模型内容保存 `retry_exhausted` 挂起；执行器错误在 Run 停止写入并排空子任务后，提交带诊断的 `failed` 任务状态和中断通知。用户停止、Host 重启与等待输入各自保留原有可恢复的挂起语义。主 Agent 对模型内容仍通过[产物校验接管](2026-09-26-bid-validation-main-agent-recovery.md)取得诊断和受控恢复权；程序故障须由主会话定位并修复，不能以同一模型候选重新执行来掩盖。

本记录收窄[主会话有界接管](../feature/2026-09-23-bid-s2-s5-goal-recovery.md)的挂起范围；旧事件含义保留在该记录中，当前主 Agent 授权与恢复由[Bid 与 Goal 解耦](../architecture/2026-09-29-bid-goal-decoupling.md)负责。

## Alternatives considered

**把所有结构化问题当作模型错误。** 基础设施错误也可能带有结构化问题，不能因为错误类相同就反复请求模型修复。

**执行器错误继续保留可恢复 Run。** 会把固定程序错误呈现为模型未完成，并允许相同代码不经修复再次执行。

## Consequences

非模型错误会保留失败诊断，但不授予自动恢复工具权限；修复程序或输入后由主会话重新发起相应任务。模型提交缺失保留具体子任务的问题码，主 Agent 可仅针对失败单元给出修复指令。测试覆盖结构化问题保留、基础设施故障分类与失败状态的 Run 结算。
