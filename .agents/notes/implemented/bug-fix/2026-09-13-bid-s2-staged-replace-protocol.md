# Agent Note: S2 staged replace 严格协议

Status: implemented

## Problem

S2 新运行将未知 `replace_ref` 当作新增，恢复 checkpoint 后才拒绝同一种引用。该分支破坏 create / replace 的稳定语义，也会让稀疏 runtime ref 与基于 `Map.size + 1` 的新增编号发生覆盖。Repair 未获得当前 staged snapshot，预算耗尽时执行器仍返回正式 Artifact 引用，最终把未完成提交误报为 Artifact 缺失。

## Decision

`submit_requirement`、`submit_scoring_item` 和 `submit_compliance_item` 使用判别式 `action`：`create` 禁止 `replace_ref`，`replace` 必须携带当前 staged snapshot 或 Host 返回的真实 ref。未知 `R*`、`S*`、`C*`、不允许的阶段操作、复核 revision 不匹配和 staged 校验问题都以 structured recoverable issue 返回，保留 staged 与 revision，并结束当前 Turn；参数格式错误仍为 `ToolArgsError`。Host 以最低未占用数字分配 runtime ref，避免稀疏 checkpoint 覆盖记录。

初始任务和每轮 Repair 都说明同一 create / replace 规则。Repair 接收 `runtime.reviewSnapshot()`、当前 revision、Requirement/Scoring/Compliance refs 和 `lastIssues`；模型只能依据这些真实记录决定 create 或 replace。修复预算耗尽且 `runtime.completed` 为 false 时，执行器抛出带阶段、revision、最近问题和 staged 摘要的 `TENDER_ANALYSIS_STAGED_INCOMPLETE`，使现有 Run 按 `retry_exhausted` 挂起并从 checkpoint 恢复，而不是将不存在的正式 Artifact 交给 Validator。

本记录修正并补充 [S2 Host 提交协议](../architecture/2026-09-07-bid-s2-host-owned-submission-protocol.md)；其 Host 生成正式 ID、来源和强制 Review 的边界保持不变。

## Alternatives considered

**仅在恢复 checkpoint 后拒绝未知引用。** 不采用；同一个参数的含义不能随运行来源改变，且新运行仍会接纳模型猜测的 ref。

**未知引用自动降级为新增。** 不采用；这会掩盖模型错误，并使稀疏 ref 与计数分配覆盖已有 staged 记录。

**只扩充 Prompt。** 不采用；Prompt 不能阻止直接工具调用，也不能保证 Repair 知道真实 runtime refs。

**预算耗尽后返回预期 Artifact 路径。** 不采用；S2 尚未提交正式产物，后续 `TENDER_ANALYSIS_ARTIFACT_MISSING` 会错误归因。

## Consequences

历史 runtime refs 不能跨 S2 Run 复用；模型必须按 Host 返回值或 snapshot 修改记录。失败 Run 保留 staged checkpoint，用户请求继续时可在相同记录上重试。回归测试固定三类 create / replace、严格未知引用的 Turn 边界、稀疏恢复编号、Repair 快照、错误引用后的自动修复链和预算耗尽出口。
